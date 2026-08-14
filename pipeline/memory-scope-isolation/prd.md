# PRD — memory-scope-isolation(修复性质,change-id: memory-scope-isolation)

> 性质:bug 修复,非新增业务功能。范围已在 s1a 调研+两轮用户拍板中固化(见 `research/intake.md` 末两节"用户已答复"、`research/facts.md` F1-F6),本文档只做起草蒸馏,不重新judge范围是否合理。

## 问题陈述

**现象(证据等级:数据/实测,`research/facts.md` F1)**:agentmemory 的作用域隔离(`agentId`/`project`)对 `memory_save` 主动存储的记忆结构性失效。全仓 grep 实测确认,`mem::remember` 的两条外部触发入口(`server.ts:190`、`api.ts:1022`)与其上游代理入口(`standalone.ts` 的 `validate`/`handleProxy`)、以及最上游的 MCP 工具 schema(`tools-registry.ts:55-87`)、读侧转换函数(`memory-utils.ts:11` `memoryToObservation`)共 5 处在传递链路上把 `agentId`/`project` 字段丢弃或从未开放,而下游本体 `remember.ts` 早已支持接收这两个字段(102-105/125 行)。

**为什么这是问题(三层追问)**:
1. 表层:用户通过 MCP 工具 `memory_save` 主动存储一条记忆时,无法为其打上 `agentId`/`project` 标记。
2. 中层:作用域隔离的读侧(`memory_recall`/`mem::search`)与下游存储本体(`remember.ts`)都已具备按 `agentId`/`project` 过滤的能力(`server.ts:116-129` 的 `memory_recall` 分支已注释"no agentId → falls back to env AGENT_ID"),但写侧五处丢字段导致这套过滤能力对"主动存储"的记忆形同虚设——过滤器在,但被过滤的字段从未落库。
3. 根因/业务代价:本机是多 agent(主会话+子 agent)、多项目共用同一 worker 的实际部署(`~/.config/agentmemory/service.env` 无 `AGENT_ID`,`codebase-survey.md` §4 已核验),`memory_save` 是 agent 之间沉淀经验、跨会话复用记忆的主入口。作用域隔离一旦对该主入口失效,不同 agent/不同项目的记忆会在检索时相互污染或错误共享,直接削弱系统对"隔离边界"这一核心承诺的可信度;且失效面隐蔽(功能"看起来在跑",不报错、不降级,只是标记恒为空),不主动修不会自愈。

**支持信号(证据等级:数据)**:`codebase-survey.md` §2 核实现有自动化验收(`evidence/scope-isolation.sh`、`test/agent-id-scope.test.ts`、`test/agent-isolation-search.test.ts`)全部绕开三条真实写入路径,即该 bug 此前未被任何既有测试发现,是"验收盲区放过真 bug"的实例(对应坑库 P19)。

**不解决的代价**:多 agent/多项目共享一个 worker 的现状下,继续依赖 `memory_save` 沉淀的记忆没有可信的作用域边界,后续任何"按 agent/project 隔离记忆"的下游能力(检索过滤、清理、审计)都建立在错误数据之上,越晚修复,历史脏数据(无 scope 标记的记忆)积累越多、治理成本越高。

## 需求清单

> 前 5 条是 `research/facts.md` F1 实测确认的必改代码补丁(每条对应链路上一个丢字段/未开放字段的点);FR-6、FR-7 是让前 5 条补丁在真实运行环境(而非仅 vitest mock)里实际生效的前置依赖,按需求方要求单独成条,不与代码补丁混写。所有代码类 FR 的验收均要求"改前必红、改后必绿"的行为用例,且不得使用 `readFileSync`+正则匹配源码文本的伪行为测试(`codebase-survey.md` §2.5 已指出这类测试测不出运行时行为)。

### FR-1(P0)| `memory-utils.ts:11` `memoryToObservation()` 补 agentId + project 透传(读侧转换)

- **Given**:一条底层 `Memory` 记录携带 `agentId="pm-agent"`、`project="worker-config"`
- **When**:调用 `memoryToObservation()` 做读侧结构转换(该函数被 `memory_recall`/`mem::search` 等展示路径复用)
- **Then**:返回的 `Observation` 对象包含相同的 `agentId` 与 `project` 字段值,不丢失、不被置空
- **边界回归**:Given 一条 `Memory` 记录 `agentId`/`project` 均为 `undefined`,When 转换,Then 输出对应字段同为 `undefined`(不抛错、不误填默认值);既有 12 处调用点(README 已排查,3 文件)对应的既有测试保持通过,不回归

### FR-2(P0)| `standalone.ts` 三处同改:`interface Validated`(96-108)+ `validate()`(116-126)+ `handleProxy()`(175-186)

- **Given**:MCP stdio 客户端(如 Claude Code)调用 `memory_save` 工具,参数携带 `agentId="a1"`、`project="p1"`
- **When**:请求经 `handleToolCall` → `validate()`(补齐 `Validated` interface 的 `agentId`/`project` 字段解析与白名单纳入)→ `handleProxy()`(补齐 175-186 行的 body 重建逻辑,携带 `agentId`/`project` 而非仅 `content/type/concepts/files`)
- **Then**:实际发往 worker 的 `POST /agentmemory/remember` 请求体(mock fetch 捕获的 `init.body`)包含 `agentId="a1"`、`project="p1"`
- **验收用例约束(硬性)**:新增用例必须放进 `test/mcp-standalone-proxy.test.ts`(该文件 mock 边界只到 `globalThis.fetch`,`validate`/`handleProxy` 是真实代码);**不得放进 `test/mcp-standalone.test.ts`**——该文件用 `instantLocalFallbackProbe` 把 livez 探针钉死 `ok:false` 并拦真实 fetch,强制走 `handleLocal`,放进去会因空测通不过判定(`facts.md` F2 已确认这是本条最容易踩的坑)
- **边界回归**:Given `agentId`/`project` 均未传,When 走同路径,Then body 中该两字段不出现或为 `undefined`,不破坏现有用例(如 `#507` memory_recall 相关断言)
- **依赖**:此补丁只在实际运行的 standalone MCP server 是本补丁编译产物时才对生产可见,见 FR-7

### FR-3(P0)| `tools-registry.ts:55-87` `memory_save` inputSchema 补 `agentId` 字段

- **Given**:MCP 工具发现请求(`tools/list`)或 `getAllTools()` 直接调用
- **When**:读取返回的 `memory_save` 工具 schema 的 `properties`
- **Then**:`properties` 新增 `agentId`(string 类型,风格与同文件 424/440/452/515 行既有 actions/messages 类工具的 `agentId` 字段一致);`required` 字段不变、工具总数不变
- **回归**:既有 4 个测试(`test/consistency.test.ts`、`test/mcp-standalone.test.ts`、`test/mcp-surface-default.test.ts`、`test/tool-count-consistency.test.ts`)实跑通过,不因新增 property 而失败
- **依赖**:是 FR-2/FR-4 的前置——不补 schema,MCP 客户端无合法参数可传,FR-2/FR-4 拿到的 `args.agentId` 恒为 `undefined`(`facts.md` F1 已确认此为硬性遗漏)

### FR-4(P0)| `server.ts` `memory_save` 分支(168-198)转发 `args.agentId`

- **Given**:`POST /agentmemory/mcp/call`,body = `{name:"memory_save", arguments:{..., agentId:"a1"}}`
- **When**:`registerMcpEndpoints` 注册的 switch 命中 `memory_save` 分支
- **Then**:`sdk.trigger("mem::remember")` 收到的 payload 含 `agentId:"a1"`(仿照同文件 116-129 行 `memory_recall` 分支的既有透传写法,以及 722/738/766/854 行 actions/messages 类工具直接透传 `args.agentId` 的既有约定)
- **验收用例**:新增行为用例,复用 `test/mcp-resources.test.ts` 第 10-66 行现成的 `mockKV()`+`mockSdk()`+`makeReq()` 脚手架,用 `mockSdk.overrideTrigger("mem::remember", handler)` 捕获 payload 断言;改前必红、改后必绿
- **边界回归**:`agentId` 未传时,payload 不含该字段或为 `undefined`;既有 `project` 透传逻辑(182-185 行)不受影响

### FR-5(P0)| `api.ts` `api::remember`(994-1035)接受 `body.agentId`

- **Given**:`POST /agentmemory/remember`,body 含字符串 `agentId`(含一个超过 128 字符的场景)
- **When**:`api::remember` 处理请求
- **Then**:沿用 `api.ts:605-609`(`api::session::start`)既有写法——`typeof body.agentId === "string" && body.agentId.trim().length > 0` 则取值并 `.slice(0,128)` 截断,否则 `undefined`,再 `?? getAgentId()` 兜底;处理后的值随 `sdk.trigger("mem::remember")` payload 送达下游
- **验收用例**:新增行为用例(非 `readFileSync`+正则的源码文本匹配式测试——现有 `memories-pagination.test.ts`/`session-end-triggers-graph.test.ts`/`consistency.test.ts` 是这类伪测试,不可参照),复用 `mcp-resources.test.ts` 同款 `mockKV/mockSdk/makeReq` 脚手架,取 `sdk.getFunction("api::remember")` 直接调用 + `overrideTrigger("mem::remember")` 断言 payload,覆盖"正常长度透传"与"超长截断至 128 字符"两个场景
- **边界回归**:`agentId` 缺失或空串时,行为与当前一致(`undefined`,不报错)

### FR-6(P0)| D10:systemd `ExecStart` 与 `ExecStopPost` 切换到工作树构建产物(前置依赖,非代码补丁)

- **Given**:`npm run build` 已在仓库工作树(基于当前 HEAD `acb7772` 新开的分支,不同步 `origin/main`,理由见非目标)执行成功,产出 `dist/cli.mjs`(与 `dist/standalone.mjs`);`~/.config/systemd/user/agentmemory.service` 的 `ExecStart` 与 `ExecStopPost` **两行**均改为指向该工作树 `dist/cli.mjs` 的绝对路径(`WorkingDirectory` 保持 `%h/.agentmemory` 不动)
- **When**:执行 `systemctl --user daemon-reload && systemctl --user restart agentmemory`
- **Then**:`systemctl --user is-active agentmemory` 返回 `active`;`/agentmemory/livez` 探活返回 200;此后 FR-1/FR-3/FR-4/FR-5 的修复在真实运行的 worker 服务中生效(可发一次真实 `memory_save` 请求核验落库记录带 `agentId`/`project`,而非仅 vitest mock)
- **失败/回退路径**:若 restart 后服务不 `active` 或 `livez` 不通,将 `ExecStart`/`ExecStopPost` 两行改回原 nvm 全局包路径,`daemon-reload`+`restart` 回滚;是否触发回滚为人工判断,不设自动判据(intake Q7 已拍板);回滚只需改这两行路径,不涉及其它状态还原(`codebase-survey.md` §4 已确认全局包目录本次不动)
- **未决**:此条"真实构建+拉起"目前只有静态代码判断(`facts.md` U2),未做过端到端实测,见"开放问题"第 1 条

### FR-7(P0)| `plugin/.mcp.json` 切换到工作树构建产物,使 MCP stdio 主路径实际生效(前置依赖,非代码补丁)

- **Given**:`plugin/.mcp.json` 当前以 `npx -y @agentmemory/mcp` 启动 standalone MCP server(即 FR-2 补丁所在的 `standalone.ts` 编译产物;这是与 D10/FR-6 的 worker 服务**相互独立的两个进程**)
- **When**:将该配置的 `command`/`args` 改为直接执行工作树构建产物 `node <worktree>/dist/standalone.mjs`(与 FR-6 对 systemd 的做法同构),重启/重连 MCP 客户端
- **Then**:实际连接的 standalone MCP server 运行的是携带 FR-2 补丁的代码;一次真实 `memory_save` 工具调用可观察到请求体含 `agentId`/`project`(而不仅是 vitest mock 断言)
- **回退路径**:改回 `npx -y @agentmemory/mcp`
- **明确排除的替代方案**:手工覆盖 npx 缓存目录下的 `standalone.mjs`——见"非目标"第 2 条

## 非目标

1. **5c:`standalone.ts:245-264` `handleLocal` 本地 fallback 写库不打 scope 标记 —— 本期不做**。原因(用户拍板,`intake.md` 第二轮批复):细节类改动若后续可用脚本或其它解耦方式实现,本期聚焦核心功能与架构、保持良好扩展性,不需要一次性做全;该路径仅在 worker 服务不可达时触发,与 P7(影子库,已判定接受现状)同一条路径,日常主路径不经过,归为**已知限制**,design.md 需书面记录,不列入本期验收范围,后续如需可用独立脚本补做。
2. **手工覆盖 npx 缓存目录下的 `standalone.mjs` —— 不采用**。原因:`facts.md` F6/U1 已用 npm 源码级证据(libnpmexec 缓存新鲜度判定逻辑)确认,`@agentmemory/mcp` 一发新版即会被静默 reify 冲掉且无任何提示,是不可靠机制;改为 FR-7(切换 `.mcp.json` 指向工作树构建产物)替代,与 D10 对 systemd 的做法同构,回滚更干净。
3. **先同步 `origin/main` 再开分支 —— 不做**。原因(用户第二轮拍板):落后的 v0.9.29 与四处补丁目标文件实测零重叠(`facts.md` F5)、且未修本 bug;基于当前 HEAD 直接开分支可把 D10 重启的变量隔离到"只改作用域补丁"一个维度,便于日后归因;后续再补同步成本不变。分支起点即当前 HEAD(`acb7772`)。
4. **为 D10 重启设专门的"安静执行窗口"或提前告知子 agent —— 不做**。原因(用户第二轮拍板 Q6):按现有重试机制处理,不额外加防护;P9(重启缓冲期约 15 秒写入丢失风险)维持既有"接受现状"判定,不为这次主动重启加码。
5. **自动回滚触发判据/联动脚本 —— 不做**。原因(用户拍板 Q7):出问题由用户人工现场判断是否回滚,不在验收脚本里做自动回滚联动。
6. **历史无 scope 标记的脏记忆回填/迁移(P3)—— 不做**。本次只保证"此后新写入"带 scope,存量数据治理不在本次范围(s1a 已排除)。
7. **MCP 与 REST 两种调用方式的统一改造/选型 —— 不做**。本次只修复既有三条写入路径各自的字段丢失问题,不合并或重构调用方式。
8. **P4/P5/P9 等 s1a 已排查并判定接受现状的已知限制 —— 维持现状**,不在本次范围内一并解决。

## 开放问题

1. **`dist/cli.mjs` 在真实 systemd `ExecStart` 切换后能否正常拉起、行为是否与当前全局包版本一致 —— 未做过端到端验证**(`facts.md` U2,目前只有静态代码判断,风险方向判为低但未证实)。谁来回答:tech-architect 在 s2a/s2b 设计 FR-6 的具体执行/验证步骤,由实现节点在 s3 落地时实际执行 `npm run build`+`systemctl restart`+`livez` 探活取得实测证据。
2. **FR-6(D10)所需的那次 `systemctl restart` 具体在什么时间点执行、由谁触发** —— 用户已明确"不额外设安静窗口、不特别防护"(intake Q6),但"这次操作本身选在何时做"(比如实现完成即做,还是排到部署阶段统一做一次)尚无人指定。谁来回答:主会话或用户,在进入 s3 实现/部署阶段前确认。
3. **FR-3(`tools-registry.ts` schema 补 `agentId`)改动后,是否需要同步执行 `npm run skills:gen` 重新生成技能文档** —— `codebase-survey.md` §1.4 指出 `getAllTools` 是该生成脚本的调用方之一,但未判断 schema 加字段是否会改变生成产物、是否需要纳入本次验收范围。谁来回答:tech-architect 在 s2a 设计 FR-3 任务卡时确认是否需要此步骤,不需要则在 design.md 书面排除。
