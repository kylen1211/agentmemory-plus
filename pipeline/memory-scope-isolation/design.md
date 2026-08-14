# design.md — memory-scope-isolation(架构与契约,s2a 草稿态)

> 消费:prd.md(FR-1~FR-7)+ research/{intake,facts,codebase-survey,build-spike}.md。无 UI 需求,无 ui-spec.md。
> 性质:修复既有链路的字段丢失,**不新增端点、不新增工具、不改数据落库结构**;外加两条让补丁在真实运行环境生效的环境切换。
> 本文所有 file:line 与实测结论均在 2026-08-14 现场复核过;s2a 新增的现场证据在"现状盘点 / preflight 证据块"标注 [s2a 实测]。

## 现状盘点

### 1. 链路与丢字段点(五处必改,全部现场复核)

写侧三条路径最终都汇到同一个下游本体 `mem::remember`(`src/functions/remember.ts:23`),而本体**早已支持** `agentId` 与 `project`(102-105 行取值 + trim + `slice(0,128)`,125 行落库),所以五处补丁全是"上游没开口子",不涉及下游改造:

| 路径 | 位置 | 现状 | FR |
|---|---|---|---|
| 读侧转换 | `src/state/memory-utils.ts:11` `memoryToObservation` | 返回体逐字段构造,不含 `agentId`/`project` | FR-1 |
| MCP stdio(真主路径) | `src/mcp/standalone.ts:96-108` `interface Validated` | 无这两个字段,后两处无处承载 | FR-2 |
| MCP stdio | `src/mcp/standalone.ts:116-126` `validate()` | 白名单只取 `content/type/concepts/files` | FR-2 |
| MCP stdio | `src/mcp/standalone.ts:175-186` `handleProxy()` | **重建 body 而非透传 `v`**,只发四个字段 | FR-2 |
| 工具 schema(最上游) | `src/mcp/tools-registry.ts:55-87` | properties 只有 `content/type/concepts/files/project`,无 `agentId` | FR-3 |
| MCP over REST | `src/mcp/server.ts:168-198` | 已处理 `project`(182-185),完全没有 `agentId` | FR-4 |
| REST(agent-mem CLI 与 stdio 的下游) | `src/triggers/api.ts:994-1035` | 泛型与 payload 均无 `agentId` | FR-5 |

关键结构性事实:`handleProxy` 是**重新构造对象**,只改 `validate` 的白名单完全无效 —— FR-2 必须三处同改,这是 s1a 盘点最重要的发现(facts.md F1)。

### 2. 读侧过滤为什么"过滤器在、却永远不命中"

`src/functions/search.ts:543` 对索引里的 observation 做 `obs.agentId !== filterAgentId` 硬过滤;而记忆进索引的唯一入口是 `remember.ts:145` 的 `getSearchIndex().add(memoryToObservation(memory))`。`memoryToObservation` 丢掉 `agentId` → 索引里所有记忆的 `agentId` 恒为 `undefined` → 只要 agentId 过滤生效,记忆一条都命不中。这就是 FR-1 的实际业务后果,不只是"字段没透传"。
对照:`project` 过滤走的是另一条路(`search.ts:500-511` 直接回查 `KV.memories` 拿 `mem.project`),**不依赖** `obs.project`,所以给 `CompressedObservation` 加 `project` 是纯增量,不改变现有过滤行为。

### 3. 可复用的既有约定(照抄对象,禁止自创写法)

- **agentId 取值与截断**:`src/triggers/api.ts:605-609`(`api::session::start`)= `typeof body.agentId === "string" && trim().length > 0 ? trim().slice(0,128) : undefined`,再 `?? getAgentId()`;与 `remember.ts:104` 的 128 截断完全一致 → FR-5 沿用。
- **MCP 分支透传**:`src/mcp/server.ts:116-129`(`memory_recall`,#817)已为读侧做过同样的事;722/738/766/854 行 actions/messages 类工具直接透传 `args.agentId` → FR-4 沿用。
- **schema 字段风格**:`src/mcp/tools-registry.ts:424/440/452/515` 已有 `agentId: { type: "string", description: ... }` → FR-3 沿用。
- **测试脚手架**:`test/mcp-resources.test.ts:10-66` 的 `mockKV()/mockSdk()/makeReq()`,其中 `mockSdk` 带 `overrideTrigger(id, handler)` 与 `getFunction(id)`,可拦 `mem::remember` 断言 payload;`test/helpers/mocks.ts`(共 53 行,3 个测试在用)的版本**没有** `overrideTrigger`/`getFunction`。
- **fetch 级 mock**:`test/mcp-standalone-proxy.test.ts:8-14` `installFetch()` 只替换 `globalThis.fetch`,`validate`/`handleProxy` 是真实代码,现有 `#507` 用例已在断言 POST body 字段。

### 4. 运行环境现状 [s2a 实测]

- systemd:`ExecStart` 与 `ExecStopPost` 都指向 nvm 全局包 `~/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs`(`systemctl --user show` 实测);服务 active,`/agentmemory/livez` 返回 200。
- `~/.config/agentmemory/service.env` 无 `AGENT_ID` → `getAgentId()` 兜底恒 `undefined`,补丁后 agentId 只能来自请求,不会被服务端环境污染。
- MCP stdio 侧:本会话实际在跑的 server 进程为 `npm exec @agentmemory/mcp`(pid 1774621,父进程即 claude 本身,cwd `/home/ky/worker-config`)。**它不是从本仓库 `plugin/.mcp.json` 起的**——已安装插件缓存 `/home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json` 是同样内容的另一份(实测 `diff` 一致,是真实文件不是软链),且 `~/.claude/settings.json` 的 `enabledPlugins` 与 `installed_plugins.json` 都指向该缓存目录。[s2b 呈批复核实测] `~/.claude/plugins/known_marketplaces.json` 里 `agentmemory` 的 marketplace source 是 `directory` 型、path 直指本仓库(`/home/ky/git/source-project/agentmemory`),缓存目录 `0.9.28` 即安装时对仓库 `plugin/` 的一次拷贝(`installed_plugins.json` 记 `gitCommitSha=d60652a`)。用户已拍板 **FR-7 两份都改**,见 ADR-2 与风险 R-3。
- 下游消费者:`agent-mem`(`~/git/config-globle/skills/summer-agentmemory-scope/scripts/agentmemory-agent.sh`,repo 外)的 `save` 分支只发 `{content,type,concepts}`,**不发 agentId**,脚本头部注释明确写着"传了也会被服务端静默丢弃"。本次修完写侧后,该脚本仍需另行改动才能真正打上 scope,不在本次范围。详见风险 R-5。

### 5. preflight 证据块:D10 依赖的构建链路是否真能跑(坑库 P6)

不假设"构建了就能跑",逐条给证据:

| 命题 | 证据 | 等级 |
|---|---|---|
| `npm run build` 能产出 `dist/cli.mjs` | s1a build-spike 实测:4.583s,`dist/cli.mjs` 105,446 字节;s2a 复核 `dist/` 现存(2026-08-14 12:05) | 实测 |
| 工作树产物拉起行为与全局包一致 | build-spike 并列对照(隔离端口/数据目录),两侧逐项一致,含 `~/.agentmemory/bin/iii` 定位、REST/Streams 监听、初始化全流程 | 实测(非 systemd 语义) |
| `dist/standalone.mjs` 是可用的 MCP server | [s2a 实测] 直接 `node dist/standalone.mjs` 喂 initialize + tools/call `memory_save`,拿到 `{"success":true}` 与落库的 memory 对象 | 实测 |
| 该产物当前**仍带 bug** | 同上返回的 memory 记录里没有 `agentId`/`project`;按 agentId 读回 `{"latestCount":0,"total":0}` | 实测(即 cases 的红锚点) |
| 未覆盖项 | 真实 systemd 单元语义(`%h` 展开、`EnvironmentFile`、`Restart=always`、`ExecStopPost`)在切换后的行为 —— 只有手工命令行对照,无 systemd 实跑 | 未验(FR-6 落地时取证) |

补充硬约束:`tsdown.config.ts` 的 `deps.neverBundle` 含 `@huggingface/transformers`、`@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk`,**产物运行时依赖同工作树的 `node_modules/`** → D10 之后该工作树的 `node_modules/` 与 `dist/` 都变成生产依赖,不可删(facts.md F3)。

### 6. 测试基线现状 [s2a 实测]

`npm test` 全量:`Test Files 5 failed | 133 passed | 1 skipped (139)`,`Tests 12 failed | 1559 passed`。归因已做:把 `HOME` 指向空目录重跑,12 条里 11 条转绿 → 由 `~/.agentmemory/.env` 被测试进程读入导致(embedding provider / auto-compress / context-slots 三组);剩 1 条 `consistency.test.ts > documented REST endpoint counts match registered API paths` 是 HEAD 上真实的 README 计数漂移,与本次改动无关。
与本次五处补丁直接相关的 9 个测试文件(97 条)**基线全绿**,已固化为 `contract/cases.md` 的 `C-REG-1`。

## 方案

### 选定方案(一句话)

在**已有的五个传递点上各开一个可选字段的口子**,不引入任何抽象层、不合并 MCP/REST 两套调用方式、不动下游落库逻辑;再用两条**只改配置指向、不改安装内容**的环境切换(systemd unit 两行 + `plugin/.mcp.json`),让补丁在真实运行的两个进程里生效。全部改动均为 additive optional,老调用方零感知。

补丁映射:FR-1 读侧转换补两字段 → FR-3 工具 schema 开放 `agentId`(最上游,不开则下游拿不到值)→ FR-2 stdio 三处同改 → FR-4 MCP-over-REST 分支透传 → FR-5 REST 端点解析。环境侧:FR-6(worker 进程)与 FR-7(MCP stdio 进程)是**两个相互独立的进程**,各切各的。

### ADR-1 | D10 让 systemd 跑工作树构建产物:改 `ExecStart`/`ExecStopPost` 指向,而非 npm link / 覆盖全局包

- **背景**:补丁改的是 `src/**`,而在跑的 worker 是 nvm 全局包 0.9.28;不换执行体,FR-1/FR-3/FR-4/FR-5 对生产不可见。候选:①改 unit 两行指向工作树 `dist/cli.mjs`;②`npm link` 让全局命令软链到工作树;③直接把构建产物覆盖进全局包目录。
- **决定**:选 ①(用户 intake Q2 已拍板)。`ExecStart` 与 `ExecStopPost` **两行同改**(facts.md F4:只改 ExecStart 会出现"新码启动、旧码停止"的混搭),`WorkingDirectory` 保持 `%h/.agentmemory` 不动。
- **被否 ②(npm link)**:软链改的是**全局命名空间**,影响的不止 systemd 一个消费者(任何 `agentmemory` 命令行调用都会被改道),而 unit 文件改两行的作用域精确到这一个服务;且 link 状态存在于 nvm 目录里,回滚要记得 `npm unlink`,比"把两行路径改回去"更容易忘、更难在事后看出来。
- **被否 ③(覆盖全局包目录)**:破坏性覆盖,原始文件无处可回;且与 npx 缓存覆盖同类,下次 `npm i -g` 或版本更新会静默冲掉,失效时无提示。
- **代价**:此后改 `src/**` 必须重新 `npm run build` 才对 worker 生效(不再是"装个新版本"的心智);工作树的 `dist/` 与 `node_modules/` 升格为生产依赖,删不得、`git clean -xdf` 不得;工作树切分支会直接改变生产行为。回滚成本:改回两行 + `daemon-reload` + `restart`,无其它状态需要还原。

### ADR-2 | MCP stdio 补丁生效方式:改 mcp 配置指向构建产物(非覆盖 npx 缓存),且仓库与插件缓存**两份配置同改**

- **背景**:`plugin/.mcp.json` 以 `npx -y @agentmemory/mcp` 起 stdio server(FR-2 补丁的运行载体)。两个相互独立的问题:**怎么改**——候选 ①把 `command`/`args` 改成 `node <worktree>/dist/standalone.mjs`;②手工覆盖 npx 缓存目录里的 `standalone.mjs`。**改哪份**——候选 ⓐ只改仓库 `plugin/.mcp.json`(PRD FR-7 原文);ⓑ只改客户端实际加载的插件缓存 `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json`;ⓒ两份都改。
- **决定**:方式选 ①(用户第二轮拍板),与 ADR-1 对 systemd 的做法同构;**作用对象选 ⓒ 两份都改(用户 s2b 呈批拍板,原话:"两份都改")**——两份的 `command`/`args` 同步切到 `node /home/ky/git/source-project/agentmemory/dist/standalone.mjs`,内容保持一致,`env` 三项不动。
- **被否 ②(覆盖 npx 缓存)**:facts.md F6 已用 npm 11.16.0 自带 `libnpmexec/lib/index.js` 源码取证——缓存新鲜度判定依据是 `package-lock.json` 的 tarball `resolved` 与 registry manifest `_resolved` 是否相等(78-83 行),**与文件内容、mtime 无关**;而 `@agentmemory/mcp` 这种不带版本号的 spec 命中 `npxByNameOnly` 分支,每次都以 `preferOnline: true` 联网拉 manifest(26-37 行,该标志写在 `...flatOptions` 之后,用户侧 `--prefer-offline` 覆盖不掉)。结论:**registry 上 `@agentmemory/mcp` 一发新版就会 reify、手工补丁被静默冲掉且无任何提示**;当前 registry latest 是 0.9.28,而 origin/main 已有 v0.9.29 release commit —— 失效是"何时"而非"是否"的问题。另有路径陷阱:待覆盖文件不在 `@agentmemory/mcp` 包内(该包只有 418 字节的 `bin.mjs`),真实目标在传递依赖 `@agentmemory/agentmemory/dist/standalone.mjs` 下,取证一度记错层级。
- **被否 ⓐ(只改仓库那份)**:客户端当下加载的是插件缓存那份(`enabledPlugins` + `installed_plugins.json` 双向指向,实测),只改仓库 → 重连后跑的仍是 `npx` 拉的 0.9.28 旧产物,FR-7 的 Then("一次真实 `memory_save` 可观察到 agentId")永远达不成,而只看配置的 `C-FR7-1` 还会绿——正是坑库 P28 那类"配置改了、运行没变"的假绿。
- **被否 ⓑ(只改缓存那份)**:缓存目录是仓库 `plugin/` 的一次拷贝(marketplace source 为 `directory` 型直指本仓库,实测),且路径按版本号分目录。只改缓存 → 下次 `/plugin` 更新、或版本号一变(新建 `.../0.9.29/` 目录)就以仓库里的旧内容重新铺开,补丁被静默冲回 `npx`,与被否的 ②(覆盖 npx 缓存)是同一种失效模式。
- **两份都改的性质**:缓存那份让改动**当下生效**,仓库那份让改动**在下次插件更新后仍然生效**(更新即从仓库重新拷贝);两个时间面各占一份,缺一份就在某个时间点失效。
- **代价**:①两份 mcp 配置里都出现本机绝对路径,而仓库那份**随插件一起对外发布**,本机路径对其他使用者无意义——发布前必须改回,这条长期约束记在 R-3,本次不做自动化拦截;②缓存那份属 `~/.claude` 用户配置域,不受版本控制、改动无 diff 可查、插件更新会覆盖,只能靠 `C-FR7-1b` 每轮 gate 复核它是否仍在位;③两份文件从此要人肉保持一致,漂移了不会有人报错(`C-FR7-1b` 顺带断言两份 command/args 一致,把漂移变成红);④与 ADR-1 同样需要"改了 `src/**` 就得重新 `npm run build`"。
- **回滚**:两份各自把 `command`/`args` 改回 `"npx"` / `["-y","@agentmemory/mcp"]` 即可,无其它状态需还原(缓存那份也可用重装插件覆盖回去);两份互不依赖、可单独回滚,但**只回滚一份会造成发布态与运行态不一致**,要么同回、要么在 R-3 补一行说明。

### ADR-3 | 验收用例的落点:FR-2 钉死在 proxy 文件,其余四条集中到一个新建测试文件

- **背景**:五处补丁需要"改前必红、改后必绿"的行为用例。现有资产两极分化:`mcp-standalone-proxy.test.ts` 与 `mcp-resources.test.ts` 是真行为测试;`mcp-standalone.test.ts` 用 `instantLocalFallbackProbe` 把探针钉死 `ok:false` 并拦真实 fetch,**强制走 `handleLocal`,永远进不了 `handleProxy`**;而 `memories-pagination.test.ts` / `session-end-triggers-graph.test.ts` / `consistency.test.ts` 这三个 import `triggers/api` 的测试是 `readFileSync`+正则匹配源码文本的伪行为测试。
- **决定**:FR-2 的用例**必须**放 `test/mcp-standalone-proxy.test.ts`,并把这条约束写进 `contract/cases.md` 的命令本身(cmd 只跑该文件),放错文件即零匹配即判红,不靠人工复核;FR-1/FR-3/FR-4/FR-5 集中放**新建** `test/memory-scope-isolation.test.ts`,文件内自带 `mockKV/mockSdk/makeReq`(照抄 `mcp-resources.test.ts:10-66`)。
- **被否 A(FR-2 放 `mcp-standalone.test.ts`)**:那里加断言只能覆盖 `handleLocal`,是典型的"mock 绿 ≠ 真分支覆盖"(坑库 P19),恰是本 bug 逃过既有验收的同款成因。
- **被否 B(把 `overrideTrigger`/`getFunction` 补进共享 `test/helpers/mocks.ts` 复用)**:能省掉约 55 行重复,但要改一个被 3 个既有测试共享的文件,把一次 bug 修复的改动面扩大到无关测试上;且仓库现状本就是"每个测试文件自带 mock"(`mcp-resources.test.ts` 自己也是复制的)。代价记账:新文件里有一份约 55 行的 mock 复制,列为已知重复,后续若第三处再要用同一套,再提取到 helpers 不迟。
- **代价**:测试文件数 +1;FR-2 与其余 FR 的用例分居两个文件,阅读时要跳。

### ADR-4 | 防"空测假绿"的判据机制:退出码 + 输出下限双条件

- **背景**:`contract/cases.md` 生成的用例只能断言退出码与输出正则。[s2a 实测] `npx vitest run <file> -t <不存在的名字>` **exit 0**(输出 `Tests 16 skipped (16)`)——只断言退出码 0 的话,"用例根本没写"和"用例全绿"无法区分。
- **决定**:每条 vitest 类用例同时钉 `expect_exit: 0` 与 `expect_out: "Tests +([2-9]|[1-9][0-9]+) passed"` 形式的通过条数下限(FR-5 要求 3 条),并强制新用例标题以 `FR-N ` 开头供 `-t` 精确取。
- **代价**:测试标题成为契约的一部分,改名即判红(这是有意的);条数下限只保证"有 N 条通过",不保证断言质量 —— 断言质量由 gate 的变异抽样与 code-reviewer 兜。

### ADR-5 | `CompressedObservation` 增加可选 `project` 字段

- **背景**:FR-1 要求透传 `agentId` 与 `project`,而 `src/types.ts:46-64` 的 `CompressedObservation` 只有 `agentId?`,没有 `project`。
- **决定**:additive 增 `project?: string`,只增不改不删。
- **被否(只透传 agentId、放弃 project)**:能零类型改动,但 PRD FR-1 明写两字段,且未来读侧若要按 project 过滤索引内容会再来一次改动。
- **代价**:`CompressedObservation` 是被 observation 采集面广泛使用的公共形状,加字段等于扩大公共类型;实测确认现有 project 过滤走 `KV.memories` 直查(`search.ts:500-511`)而非 `obs.project`,故本次加字段**不改变任何既有过滤行为**,风险限于类型面。

### ADR-6 | 分支起点:基于当前 HEAD 直接开分支,不先同步 origin/main

- **背景**:落后上游 2 个提交(含 v0.9.29 project-scope parity)。**决定**:基于当前 HEAD 开分支(用户第二轮拍板)。**理由**:五个关键文件与上游 diff 为空、上游没修本 bug(facts.md F5);更重要的是 D10 那次重启要把变量隔离到"只换了作用域补丁"一个维度,同步会顺带引入 second-instance guard / frame-guard / cli 未知命令拒绝等无关行为变更,出问题归因困难。**代价**:后续要补一次同步(成本不变,只是延后)。

### 已知限制(本期书面记录,不修)

- **5c:`standalone.ts:245-264` `handleLocal` 本地 fallback 写库不打 scope**。用户拍板本期不做:该路径仅在 worker 不可达时触发,与 P7(影子库,已接受现状)同一条路径,D10 之后 worker 常驻、日常主路径不经过。后果:极端情况下 fallback 写进 `~/.agentmemory` standalone JSON 的记录仍无 scope 标记,且与主库不是同一份数据。后续可用独立脚本补做。

## 接口契约

- **契约档位:`cases`**(与账本 `contract_tier` 的 s0 预判一致)。**唯一事实源:`pipeline/memory-scope-isolation/contract/cases.md`**,本节只引用,不复述任何字段定义。
- **选 cases 而不选 openapi 的理由**:本次不新增、不删除、不重命名任何 REST 端点或 MCP 工具,对外形状的全部变化只是"在三处既有的可选字段集合里各多一个可选字段"(`agentId`,以及 stdio 侧补齐已存在的 `project`),`required` 不变、工具总数不变、状态码与错误语义一字不改 —— 用 openapi 描述会把 90% 篇幅花在复述未改动的既有面上,反而把"到底改了什么"埋掉。而本次真正需要被冻结、被机器判定的是**七条 FR 各自的可执行判据**(含两条纯环境切换 FR,openapi 根本无从表达),正好是 cases 档的形态。
- **cases.md 覆盖**:12 条用例覆盖 FR-1~FR-7 全部七条 + 一条回归子集;其中 11 条可确定性生成为可执行脚本,1 条(`C-FR7-3`,真实 MCP 客户端重连观察)标 `manual`,`gen-contract.sh --dry-run` 以 PARTIAL(exit 10)登记,交主会话记 `uncovered`。
- **错误与超时语义**:沿用既有约定,不在本次变更范围——错误返回形状、鉴权失败处置、`content is required` 校验、`project` 非空串校验全部保持原样;新增字段一律"缺省即 `undefined`,不报错、不填默认值",这条**边界行为**已在 cases.md 每条 FR 的用例里作为独立断言钉死。
- **幂等语义**:`mem::remember` 的既有幂等/覆盖语义(supersede + version 递增)不受本次改动影响,不重复定义。

## 数据模型

### 落库结构:零变更、零迁移

`src/types.ts:83-105` 的 `Memory` **本来就有** `agentId?: string` 与 `project?: string`,`remember.ts:124-125` 也本来就在写。本次五处补丁全部发生在**到达落库之前的传递层**,持久化结构一个字段不加、不改、不删 → **不存在数据迁移**。

### 类型与 schema 变更(全部 additive optional)

| 位置 | 变更 | 约束 | 兼容性 |
|---|---|---|---|
| `src/types.ts` `CompressedObservation` | 增 `project?: string` | 可选、字符串 | 老 observation 记录无该字段即 `undefined`,读路径已按可选处理 |
| `src/state/memory-utils.ts` `memoryToObservation` | 输出增 `agentId`/`project` 透传 | 值原样来自 `Memory`,不 trim、不填默认 | 两字段为 `undefined` 时输出同为 `undefined` |
| `src/mcp/standalone.ts` `interface Validated` | 增 `agentId?: string`、`project?: string` | 模块私有类型 | 无外部消费者(全文件唯一导出入口是 `handleToolCall`) |
| `src/mcp/tools-registry.ts` `memory_save.inputSchema` | properties 增 `agentId: {type:"string"}` | `required` 保持 `["content"]`,工具总数不变 | 老客户端不传即 `undefined`;**生成物 `plugin/skills/agentmemory-mcp-tools/REFERENCE.md` 必须用 `npm run skills:gen` 重生成**,否则 `skills:check` 判 DRIFT(现场核实 `scripts/skills/generate.ts:68-84` 从 properties 生成参数表)——这同时是 PRD 开放问题 3 的答复:**需要执行,并纳入本次验收(`C-FR3-2`)** |
| `src/triggers/api.ts` `api::remember` | 泛型与解析增 `agentId?: string` | `trim()` 后非空则 `slice(0,128)`,否则 `undefined`;再 `?? getAgentId()` 由下游兜底 | 不传即当前行为 |

### 存量数据处置(expand-contract 的 expand 阶段,且**不做 contract**)

- 历史记忆里绝大多数 `agentId`/`project` 为 `undefined`(实测:`agentId=*` 口径总量 428 条,本次前按任一 probe agentId 过滤均为 0)。
- **只 expand 不 contract**:新写入带 scope,存量原样保留,不回填、不重写、不删旧字段(PRD 非目标 6)。
- 存量可见性通道**已存在**,不需要新造:按 agentId 过滤的列表口径支持 `includeOrphans=true` 显式纳入无 scope 的历史记录,也支持 `agentId=*` 完全绕过 scope(`api.ts:1913-1932`);检索侧在隔离模式下是 fail-closed 语义,拒绝跨 agent 读并提示传 `agentId: "*"`(`search.ts:400-406`)。
- 由此产生的**过渡期现象**(需在 s5/s6 认知,不是缺陷):补丁生效后,新旧记忆在同一库里 scope 标记不一致,按 agentId 过滤的检索会"看不见"历史记忆。这是 PRD 已接受的范围划分,不在本次治理。

## 任务拆分

无前端活(本次无 UI 面)。**frontend-dev:无。** 全部落在 backend-dev(五处代码补丁 + 用例)与 devops-engineer(两条环境切换 + 构建),s2b 出具体任务卡。

### 组 A — backend-dev(代码补丁,同一分支同一工作树,顺序执行)

| 组内序 | 覆盖 FR | 改动面 | 验收用例 |
|---|---|---|---|
| A1 | FR-3 | `src/mcp/tools-registry.ts` schema 加 `agentId` + `npm run skills:gen` 重生成 `plugin/skills/agentmemory-mcp-tools/REFERENCE.md` | C-FR3-1、C-FR3-2 |
| A2 | FR-1 | `src/types.ts`(`CompressedObservation` 加 `project?`)+ `src/state/memory-utils.ts` | C-FR1-1 |
| A3 | FR-5 | `src/triggers/api.ts` `api::remember` | C-FR5-1 |
| A4 | FR-4 | `src/mcp/server.ts` memory_save 分支 | C-FR4-1 |
| A5 | FR-2 | `src/mcp/standalone.ts` 三处(`Validated` / `validate` / `handleProxy`),用例进 `test/mcp-standalone-proxy.test.ts` | C-FR2-1 |
| A6 | 全组 | 回归子集复跑 | C-REG-1 |

新建文件:`test/memory-scope-isolation.test.ts`(承载 FR-1/FR-3/FR-4/FR-5 的用例,自带 mock 脚手架)。

### 组 B — devops-engineer(环境切换,依赖组 A 全部合入主工作树)

| 组内序 | 覆盖 FR | 动作 | 验收用例 |
|---|---|---|---|
| B0 | (FR-6/FR-7 共同前置) | 在**主工作树**执行 `npm run build`,确认 `dist/cli.mjs` 与 `dist/standalone.mjs` 是含补丁的新产物 | 由 B1/B2 的用例间接判定 |
| B1 | FR-6 | 备份 → 改 `~/.config/systemd/user/agentmemory.service` 的 `ExecStart` 与 `ExecStopPost` **两行** → `daemon-reload` → `restart` → 探活 | C-FR6-1、C-FR6-2 |
| B2 | FR-7 | 备份**两份**配置 → 把仓库 `plugin/.mcp.json` 与插件缓存 `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json` 的 `command`/`args` 同步改为 `node /home/ky/git/source-project/agentmemory/dist/standalone.mjs`(`env` 三项不动,两份内容保持一致)→ 客户端重启/重连 | C-FR7-1、C-FR7-1b、C-FR7-2、C-FR7-3(manual) |

### 依赖顺序(DAG)与理由

```
A1(FR-3 schema)──┬──> A5(FR-2 stdio)
                  └──> A4(FR-4 server)
A2(FR-1)  A3(FR-5)   [与 A1 无依赖,可任意先后]
所有 A ──> A6(回归) ──> B0(build) ──┬──> B1(FR-6 systemd)
                                     └──> B2(FR-7 .mcp.json)
```

- **FR-3 是 FR-2/FR-4 的前置**:schema 不开 `agentId`,MCP 客户端就没有合法参数可传,FR-2/FR-4 拿到的 `args.agentId` 恒 `undefined`,整条链路仍不通(facts.md F1)。
- **FR-6/FR-7 是"让代码补丁在真实环境生效"的前置**:五处补丁只改 `src/**`,而 worker 与 stdio server 跑的都是别处的旧产物;不做这两条,FR-1~FR-5 对生产不可见。反过来,这两条必须**排在全部代码补丁合入主工作树之后**——systemd 与 mcp 配置指向的是主工作树的 `dist/`,若在子工作树里做,切换过去的是没有补丁的产物。
- **B0 是硬前置且不可省**:`dist/` 被 `.gitignore` 排除、不随代码合并自动更新,改完 `src/**` 不重新 build,B1/B2 切过去的仍是旧产物(这正是 C-FR6-2 / C-FR7-2 要抓的"配置改了但代码没生效")。
- **实现约束(facts.md F3)**:`deps.neverBundle` 让产物运行时依赖同工作树 `node_modules/`。**D10 之后不得删除主工作树的 `node_modules/` 与 `dist/`**,也不得对该工作树 `git clean -xdf`;任何清理都会让 worker 在下次重启时起不来。
- **构建副作用(build-spike 附录)**:`npm run build` 会给 `plugin/scripts/*.mjs` 等加可执行权限位,产生与本次无关的 `git status` 噪音,B0 完成后核对并复原,不要混进补丁 diff。
- **写前备份(坑库 P34)**:B1/B2 都是对既有配置文件的覆盖式修改,**先备份原文件、再写**;需要人确认的场合,确认动作排在写入之前,不做"先改了再拿 diff 给人看"。B2 要备份的是**两个**文件,备份路径分开、不要互相覆盖。
- **B2 跨域改动的边界(用户已拍板,ADR-2)**:插件缓存那份位于 `~/.claude` 用户配置域、在仓库之外,不进本次 git diff、也不进 review 的代码面;它属于**环境操作**,由 devops-engineer 执行并在 deploy-runbook.md 的部署/回滚步骤里逐条留痕(含备份路径与回滚命令)。两份文件的 `command`/`args` 必须逐字一致,由 `C-FR7-1b` 机器判定。

## 风险与难逆点

- **R-1 | 重启窗口写入丢失(已接受,不加防护)**:B1 那次 `systemctl restart` 会让 worker 短暂不可用,P9 的约 15 秒缓冲期写入可能丢失。用户 intake Q6 已拍板不设安静窗口、不提前告知子 agent、按现有重试机制处理。执行时机(实现完即做 / 排到部署阶段统一做)仍是 PRD 开放问题 2,由主会话在进 s3 前定。
- **R-2 | gate 的全量测试项在本机基线即红,会 fail-closed 拦住 s5**:实测 12 条失败(5 文件),其中 11 条源于 `~/.agentmemory/.env` 泄漏进测试进程(`HOME` 隔离后消失)、1 条是 HEAD 上 `consistency.test.ts` 的 README 端点计数漂移,**全部与本次改动无关**。需要主会话在 s5 前择一处置:给 gate 设带 `HOME` 隔离的测试命令、或把这 12 条登记为已知基线失败。本节只报告,不擅自改 gate 配置。
- **R-3 | FR-7 的作用对象:两份 `.mcp.json`(已拍板,不再是开放项)**:实测本会话在跑的 stdio server 是 `npm exec @agentmemory/mcp`(pid 1774621,父进程为 claude),而 `~/.claude/settings.json` 的 `enabledPlugins` 与 `installed_plugins.json` 都指向已安装插件缓存 `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/`,即**客户端读的是插件缓存那一份,不是本仓库的 `plugin/.mcp.json`**(证据等级:配置级 + 进程级 + 内容级 `diff`,仍无"改哪份文件会改变客户端行为"的端到端证明——该证明只能由 `C-FR7-3` 人工重连后取得)。**用户 s2b 呈批已拍板:两份都改**——仓库 `plugin/.mcp.json` 与插件缓存那份的 `command`/`args` 均切到工作树 `dist/standalone.mjs`,理由与被否方案见 ADR-2,任务落在 B2,机检落在 `C-FR7-1`(仓库)+ `C-FR7-1b`(缓存 + 两份一致性)。**拍板后仍留的两条约束**:①仓库那份是对外发布的插件配置,含本机绝对路径,**发布前必须改回 `npx -y @agentmemory/mcp`**,本次不做自动拦截,列为长期注意事项;②缓存那份不受版本控制,`/plugin` 更新或插件版本号变化(新建 `.../<新版本>/` 目录)会把它重新铺成仓库里的内容——那时仓库那份若已改好则自动延续,若已按①改回则 FR-7 失效需重做,`C-FR7-1b` 会在下一轮 gate 判红暴露。`C-FR7-3` 仍为 manual(脚本无法驱动宿主客户端重连),覆盖对象扩展为两份文件。
- **R-4 | 探针用例向真实记忆库写数据**:`C-FR6-2`/`C-FR7-2` 每轮各写一条真实记忆(`concepts` 含 `pipeline-probe`)。这是 PRD FR-6 认可的核验方式,且必须用一次性 agentId 才能防"上一轮记录让本轮假绿"。代价是库里逐轮累积探针记录;清理属破坏性操作,须先列清单后确认再删,不进自动化。
- **R-5 | 修完写侧,日常主写入方仍不带 scope(业务收益未闭环)**:`agent-mem` 包装脚本(config-globle 仓,repo 外)的 save 分支不发 `agentId`,只把 agent 名塞进 `concepts` 做客户端过滤。本次七条 FR 全绿之后,子 agent 经 `agent-mem save` 写入的记忆**依然没有 agentId**,PRD 问题陈述里"多 agent 记忆相互污染"的实际收益要等那个脚本另行改动才兑现。不在本次范围,提请主会话作为后续变更登记。
- **R-6 | 生产依赖被绑到开发工作树(需要长期记住的耦合)**:D10 之后,用户日常在用的 worker 由一个开发工作树的 `dist/` + `node_modules/` 支撑,工作树切分支/清理/删目录都会直接影响生产服务。这是可回退的(改回两行路径),但**易被遗忘**,建议在 deploy-runbook.md 里显式写死这条约束。
- **难逆点(逐条判定)**:本次**没有真正难逆的决策**——五处代码补丁是 additive optional 可直接 revert;ADR-1/ADR-2 两条环境切换各自"改两行、改回两行"即可回滚,不涉及包目录或缓存的破坏性覆盖(这正是两条 ADR 否掉 npm link / 覆盖全局包 / 覆盖 npx 缓存的核心理由)。ADR-2 拍板后要改的是**两份** `.mcp.json`,回滚同样是两份各改回 `npx -y @agentmemory/mcp`(缓存那份另有"重装插件"这条等效退路);其中插件缓存那份在仓库之外、不受版本控制,回滚依赖 B2 留下的备份与 deploy-runbook 记录,这是本次唯一"可逆但依赖留痕"的改动。唯一不可撤销的是 R-4 那些**已写入真实记忆库的探针记录**(只能事后手工清理),以及重启窗口内**已丢失的写入**(R-1,不可追回);两者都已被显式接受。
