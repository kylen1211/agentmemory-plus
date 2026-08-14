# review.md — memory-scope-isolation(s6 全量评审)

- 评审范围:review-package.diff(Base d60652a → HEAD c257afe,9 文件 +308/-1)+ 组 B 的环境侧改动(FR-6/FR-7,不在 diff 内,现场只读核验)
- 事实源:tasks/T-A1~T-A6、T-B0~T-B2,design.md,contract/cases.md
- 现场核查过的 diff 外对象(逐项):src/functions/remember.ts:99-105(env 兜底唯一性)、src/functions/search.ts:455-545(agentId/project 过滤路径)、src/state/hybrid-search.ts:290-305、src/mcp/standalone.ts:410-455(tools/list 来源)、systemd unit 实际 ExecStart/ExecStopPost、两份 .mcp.json 与三个备份文件、git 分支与工作树状态

## 一、规格符合裁定

| FR | 判定 | 证据 |
|---|---|---|
| FR-1 读侧透传 | ✅ | src/state/memory-utils.ts:23-24 补 agentId/project 原样透传;src/types.ts:64 CompressedObservation 加 `project?`(additive optional) |
| FR-2 stdio 三处同改 | ✅ | src/mcp/standalone.ts:107-108(Validated)、127-134(validate 白名单)、193-194(handleProxy 重建 body)三处齐备,符合 design.md:23 "handleProxy 重建对象故必须三处同改" |
| FR-3 schema 开口 | ✅ | src/mcp/tools-registry.ts memory_save.properties 增 agentId(string);required 仍 `["content"]`;REFERENCE.md 参数表同步(生成物形态,行内追加在 project 之后,与 properties 顺序一致) |
| FR-4 MCP-over-REST | ✅ | src/mcp/server.ts:190-193 解析 + :201 `...(agentId !== undefined && { agentId })`,与同文件 116-129(memory_recall,#817)写法同构 |
| FR-5 REST 写入 | ✅ | src/triggers/api.ts:1004(泛型)、1026-1029(trim+slice(0,128))、1039(payload 展开);既有 project 400 校验与 201 形状未动 |
| FR-6 systemd 切换 | ✅ | `systemctl --user show agentmemory -p ExecStart -p ExecStopPost` 两行均为 `/home/ky/git/source-project/agentmemory/dist/cli.mjs`(ExecStopPost 保留 ignore_errors=yes),is-active=active;dist/cli.mjs mtime 14:05:21 早于服务 start_time 14:10:09,晚于最后一个源码 commit 31bb4bd(14:02:22) |
| FR-7 两份 .mcp.json | ✅ | 仓库 plugin/.mcp.json 与 installed_plugins.json 指向的 `/home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json` 均为 `command=node` + 工作树 standalone.mjs,env 三项逐字保留;两份内容一致 |

越界改动:无。diff 内 9 个文件逐一落在 T-A1~T-A5 的独占路径或"共享写入(依赖链串行)"的 test/memory-scope-isolation.test.ts;工作树里未跟踪的 .gitattributes(8/9)与 SCHEDULING-AND-EVICTION-NOTES.md(8/11)时间戳早于本变更,非本次产物。

TDD 证据:5 个 feat commit 时序与卡序一致(d86f67e→bb85a9a→29c84a9→3c06ab6→31bb4bd),回执逐卡给出 RED/GREEN 命令与输出。逐条对 diff 复核后,四张卡的 RED 属实(断言在补丁前必然失败),仅 T-A2 的 RED 形式偏弱,见 Minor-3。

## 二、做得好的

1. **FR-1 抓的是真 bug 不是字段美化**:src/functions/search.ts:530-543 在 BM25 命中后用 `memoryToObservation(mem)` 重建 observation 再做 `obs.agentId !== filterAgentId` 硬过滤——补丁前该函数不返回 agentId,导致 agentId 过滤一旦生效记忆一条都命不中。现场读码确认 design.md:27 的因果链成立。
2. **测试打的是真实行为**:FR-4/FR-5 用例驱动真实 `registerMcpEndpoints` / `registerApiTriggers` 并用 `overrideTrigger("mem::remember")` 捕获 payload;FR-2 用例只 mock 到 `globalThis.fetch`,`validate`/`handleProxy` 走真实代码。cases.md 点名禁止的 `readFileSync`+正则伪行为测试一处没有。
3. **"缺省不污染"被钉成独立断言**:test/memory-scope-isolation.test.ts:145、196-201 与 test/mcp-standalone-proxy.test.ts:401-402 用 `"agentId" in payload === false` / `not.toHaveProperty` 而不是 `toBeUndefined()`,能抓住"注入了值为 undefined 的键"这类静默污染。
4. **不重复兜底的决策留了可核验的注释**:src/triggers/api.ts:1023-1025 声明 env AGENT_ID 兜底只由下游 mem::remember 承担;现场核对 src/functions/remember.ts:99-105 确认该处确有 `trim().slice(0,128) ?? getAgentId()` 的唯一兜底,注释与实现一致,不是自圆其说。
5. **环境侧回滚源真实可用**:三个备份文件内容实测为改前态(systemd 备份两行仍指向 nvm 全局包;两份 .mcp.json 备份均为 `npx -y @agentmemory/mcp`),不是空壳备份。
6. **MCP 客户端能真看到新字段**:src/mcp/standalone.ts:410-455 的 tools/list 优先取 worker 返回、回落 `getAllTools()`,两条来源都已含 FR-3 的 schema —— 不存在"服务端能收、客户端不知道能传"的死角。

## 三、发现

### Important-1 | deploy-runbook.md 缺 FR-6 小节,systemd 切换的回滚与长期约束无持久留痕
- 位置:pipeline/memory-scope-isolation/deploy-runbook.md(全文只有 FR-7 的部署/回滚/红线;FR-6 仅作为"环境要求"被提及)
- 问题:本次风险最高的改动是把用户日常在用的 worker 切到开发工作树产物(design.md:201 R-6 明确"建议在 deploy-runbook.md 里显式写死这条约束")。实际落盘的 runbook 里没有:①改哪两行、怎么 daemon-reload/restart/探活;②回滚命令(`cp -p /home/ky/.local/state/agentmemory-msi/agentmemory.service.pre-msi.bak` → daemon-reload → restart);③R-6 长期约束(工作树 dist/ 与 node_modules/ 已升格生产依赖,不得删除/`git clean -xdf`,切分支会直接改变生产行为)。
- 影响:服务日后出问题时,回滚路径与备份绝对路径只存在于 T-B1 的回执文本里;一次无意的 `git clean -xdf` 或分支切换就会让 worker 下次重启起不来,而没有任何持久文档提示这一点。
- 修法:在 deploy-runbook.md 追加 FR-6 小节,三块内容逐条写死(备份路径用绝对路径,不写任何密钥值)。
- 计划所致:T-B1 卡的 Produces 未把 runbook 列入产物,T-B2 卡却按"T-B1 负责的 FR-6 小节"存在来写边界——拆卡时漏了这一项。

### Important-2 | ADR-6 要求的分支未建,9 个 commit 直接落在本地 main
- 位置:仓库 `git branch --show-current` = main;ledger.md:93 自己预警过"无任务卡负责建分支(ADR-6 要求基于当前 HEAD 开分支,需在 s4 派发前由主会话/下一会话执行)"
- 问题:design.md:112 ADR-6 拍板"基于当前 HEAD 开分支",实际 s3~s5 的 5 个 feat commit 与 4 个 pipeline commit 全部提交在本地 main 上,分支从未创建,预警项到 s6 仍未闭环。
- 影响:①本次改动与 origin/main 的后续同步只能在 main 上做 revert/rebase,ADR-6 想要的"变量隔离到一个维度"落空;②本地 main 已与 origin/main 分叉且带着生产依赖(worker 跑的 dist 来自这棵树),日后一次 `git pull --rebase` 或 `git reset --hard origin/main` 会同时回退生产行为,且没有分支名可作为定位锚点。
- 修法:成本很低——在当前 HEAD 打一个 `memory-scope-isolation` 分支名作为锚点(不需要移动 main),或由主会话在 ledger 里显式记账"接受直接落 main 的偏离"并写明后续同步方案。

### Important-3 | 发布态 plugin/.mcp.json 带本机绝对路径且处于未提交状态,两种失效模式都无拦截
- 位置:仓库工作树 `git status` 显示 ` M plugin/.mcp.json`(内容已改为 `node /home/ky/git/source-project/agentmemory/dist/standalone.mjs`);deploy-runbook.md "待确认红线" 只登记了"发布前必须改回 npx"这一面
- 问题:该文件受版本控制且随插件对外发布,现在处于"已改但未提交"的中间态。两个方向各有一个无拦截的失效模式:①**静默回退**——任何 `git checkout .` / `git stash` / 分支切换都会把它悄悄改回 `npx -y @agentmemory/mcp`,客户端下次重连就跑回旧产物,而 C-FR7-1/C-FR7-1b 只在 gate 时刻跑,不会当场报警(这正是 ADR-2 代价②担心的漂移,只是触发源从插件更新变成了本地 git 操作);②**误发布**——一次 `git add -A` 提交后随插件发版,其他使用者的 MCP server 会指向 `/home/ky/...` 直接起不来。design.md:88 只登记了②,①未被任何文档登记。
- 影响:FR-7 的运行态正确性依赖一个不受版本控制保护、也没有本地状态说明的工作树修改;失效时表现为"agentId 又不落库了"这种难归因的回归。
- 修法:s6 收尾把两条一起登记为长期 action(发布前改回 npx / 该文件当前是未提交的本机态),并在 deploy-runbook.md 的待确认红线里补一句"仓库那份处于未提交状态,git 还原类操作会静默回退 FR-7";是否改为提交 + 发布流程加检查,由主会话拍板。

### Minor-1 | standalone.ts 存的是未 trim 原值,与另两处口径不一
- 位置:src/mcp/standalone.ts:127-134(判空用 `trim().length > 0`,写入 `v.agentId = agentId` 原值)vs src/mcp/server.ts:190-193、src/triggers/api.ts:1026-1029(均写入 trim 后的值)
- 影响:当前无实际后果——下游 mem::remember(remember.ts:102-105 对 agentId、:64-67 对 project)都会 trim。但同一字段三处三种写法,后来者容易误读成"stdio 侧有意保留原样"。
- 修法:标注该卡的 Produces 原文只要求判空,若要统一,写成 `v.agentId = agentId.trim()` 即可,一行。

### Minor-2 | 工具总数 54 被硬编码进新测试,与既有 tool-count-consistency 用例重复
- 位置:test/memory-scope-isolation.test.ts:119 `expect(getAllTools().length).toBe(54)`
- 影响:日后新增/删除任一 MCP 工具需要同时改两个文件的常量,失败信息也不如专职用例清楚。
- 修法:该断言满足 T-A1 卡"工具总数与改前一致"的要求,可保留;若要去重,改成"记录改前长度并断言不变"或直接依赖 tool-count-consistency.test.ts。

### Minor-3 | T-A2 的 RED 证据形式是"用例还没写"而非"实现还没改"
- 位置:T-A2 回执 RED 记为 `Tests 2 skipped (2)` 无 passed(即 `-t "FR-1 "` 零匹配),而卡内自证要求是"先只加用例、不改实现,跑 C-FR1-1 应红"
- 影响:该条 RED 只证明用例缺席,不证明实现缺席;不过读码可独立确认结论不受影响——补丁前 memoryToObservation 不返回 agentId,test/memory-scope-isolation.test.ts:93-98 的断言必然失败。其余四卡的 RED(含 T-A3 的 git stash 复现)形式正确。
- 修法:无需返工,后续卡沿用 T-A3 那种"stash 实现后跑"的取证方式即可。

### Minor-4 | stdio 本地兜底路径仍写入无作用域记忆(计划所致,design 已登记)
- 位置:src/mcp/standalone.ts:252-275 handleLocal 的 memory_save 分支落库字段里没有 agentId/project
- 影响:worker 不可达时经 MCP 保存的记忆静默变成无作用域记录,客户端无任何提示;之后按 agentId 检索取不到。属 T-A5 明示的本期不做项(design.md 已知限制),不是本次引入的回归。
- 修法:本轮不改,建议在 s6 收尾登记为后续 action,与 ledger 里 `agent-mem CLI 补 agentId`(act_msshmki7)同批排期。

## 四、契约档位复核

design.md:122-123 声明档位 `cases`,唯一事实源 contract/cases.md。对照实际改动面:未新增/删除/重命名任何 REST 端点或 MCP 工具,三处对外形状变化均为"既有可选字段集合各多一个可选字段",required、工具总数(54)、状态码与错误语义未动;FR-6/FR-7 为纯环境切换,openapi 无从表达。实现面与声明档位一致,**无降档**;cases.md 12 条覆盖 FR-1~FR-7 + 回归子集,manual 的 C-FR7-3 已在 ledger.md:58-60 登记 uncovered,处置合规。

## 五、总裁定

**pass = false**(3 条 Important;无 Critical)。

七条 FR 的功能实现与环境切换全部核实到位,代码质量与测试真实性没有问题——三条 Important 全部落在**留痕与状态治理**上(FR-6 回滚文档缺失、ADR-6 分支未建、发布态配置处于无保护的未提交态),修复成本均为分钟级且不触碰任何源码。建议主会话按 Important-1/2/3 各补一步后直接收口,不需要返工组 A 的五处补丁。

---

## 六、第 1 轮修复复评(2026-08-14)

裁定范围:上轮 3 条 Important + 修复 diff(`fix-round1.diff`,base=c257afe → 工作树,仅 `pipeline/memory-scope-isolation/deploy-runbook.md`)。已核 `fix-round1.diff` 与 `git diff HEAD -- deploy-runbook.md` 逐字一致(仅 index 行差异),diff 即工作树真实态,非"贴出来的意图"。

### 6.1 逐条裁定

**Important-1 | deploy-runbook.md 缺 FR-6 小节 → ADDRESSED**

三块内容逐条落盘,且关键事实全部回溯真实来源核实(不采信回执宣称):
- ①部署两行 + 执行序:deploy-runbook.md:8-44。改前两行(:14-15)与备份文件 `/home/ky/.local/state/agentmemory-msi/agentmemory.service.pre-msi.bak:11-12` 实测内容逐字一致;改后两行(:26-27)与当前 `~/.config/systemd/user/agentmemory.service:11-12` 实测内容逐字一致;`daemon-reload → restart → is-active → livez` 执行序(:30-37)与 T-B1.md Produces 的执行序列一致;`%h/.local/bin/node` 实测为 `→ ~/.nvm/versions/node/v24.18.0/bin/node` 软链,路径成立。
- ②回滚:deploy-runbook.md:91-107。备份覆盖 → daemon-reload → restart → 探活 + 回滚后期望态 + 人工触发条件三件齐,与 T-B1.md「回退路径」一致。现场复跑 `systemctl --user is-active agentmemory` = `active`、`livez` = `200`,回滚文档描述的当前基线成立。
- ③R-6 长期约束:deploy-runbook.md:125-132(新增 `## 长期约束` 节)。dist/ + node_modules/ 升格生产依赖、禁 `git clean -xdf`、切分支耦合、可回退但易忘四条齐;引用 design.md:201 经核对确为 R-6 原条(逐字命中"建议在 deploy-runbook.md 里显式写死这条约束");`deps.neverBundle` 三个包与 `tsdown.config.ts:33-37` 实测一致;`dist/`、`node_modules/` 经 `git check-ignore -v` 确认为 .gitignore:1-2 忽略项,「clean 即删」的因果成立。

**Important-2 | ADR-6 分支未建 → ADDRESSED**

`git show-ref` 实测 `c257afeba8d6fbfb6d2783670000874442a3936b refs/heads/memory-scope-isolation`,确为分支 ref(非 tag/远程 ref),指向 c257afe = review.md 所见 HEAD;`git branch --show-current` = `main`,`git log --oneline -1 main` = c257afe,main 未被移动。与判据完全吻合:锚点已存在,历史未重写。

**Important-3 | plugin/.mcp.json 未提交态两种失效模式 → ADDRESSED**

deploy-runbook.md:138 新增一条,补齐上轮缺的失效模式①:显式写明 `git checkout`/`stash`/切分支会静默回退 FR-7 到 npx 旧产物、无当场报警、仅 gate 复跑 `C-FR7-1`/`C-FR7-1b` 时才暴露;同段末尾同时压住失效模式②(提交前必须先改回 npx)。与 :137 原有条目形成"发布前改回 / 提交前改回 / 会被静默回退"三面完整登记。文件本身按要求未被动:`git diff HEAD -- plugin/.mcp.json` 仍为 `command="node"` + 工作树 `standalone.mjs` 的中间态,`git status --porcelain` 仍为 ` M`,mtime 14:09:35 早于本轮修复(runbook mtime 14:49:38),确认修复方未擅自改动或提交该文件。

### 6.2 修复 diff 内新引入的问题

无 Critical、无 Important。两条 Minor:

**Minor-5 | 备份步骤缺 `mkdir -p`,按文重放会在干净环境失败** — deploy-runbook.md:20 直接 `cp -p ... /home/ky/.local/state/agentmemory-msi/agentmemory.service.pre-msi.bak`,而该目录是 T-B1 首次执行时新建的(T-B1.md 独占路径),`cp` 不会自动创建父目录。当前目录已存在故回滚可用;但若按此 runbook 在重装/清理过 `~/.local/state` 后重放部署,第 2 步会 `cp: 无法创建普通文件: 没有那个文件或目录` 直接断在备份环节(而这正是"先备份再写"要守的那一步)。建议在 :20 前补 `mkdir -p /home/ky/.local/state/agentmemory-msi`。

**Minor-6 | 「切分支会直接改变生产行为」的标题与其自身括注互相拉扯** — deploy-runbook.md:131。`dist/` 已被 .gitignore 忽略,`git checkout <branch>` 不会动 `dist/`,故切分支**本身**不改变生产行为;真正的机制是括注里写的那半句——切分支后任何一次 `npm run build` 都会把当前分支的代码送上生产。加粗标题单独被记住时会给出反向印象(要么误以为切分支即刻生效而虚惊、要么因括注纠正而低估"下次 build 就中"的真实风险)。这条是"要长期留痕"的条目,措辞精度直接决定半年后读它的人怎么判断。建议标题改成"在本工作树重新构建会直接改变生产行为(切分支本身不动 `dist/`,但换分支后的下一次 `npm run build` 就会把该分支代码送上生产)"。

### 6.3 范围外观察(不阻塞本轮,交主会话入账)

- 新增的 FR-6 部署步骤只写了「预期输出」,未写 contracts.md:47 要求的「实际验证结果(探针证据)」;实际结果落在 ledger.md:147(active + livez 200 + 探针 `probe-msi-rest-1786687825-1871768` 读回 total=1),留痕不缺,只是不在 runbook 内。既有 FR-7 小节同形,属该文件既定写法,本轮不判问题;若要收敛,建议 s6 一次性把两节的实测结果各补一行。
- 本轮修复本身仍未提交:锚点分支 `memory-scope-isolation` 停在 c257afe,不含 deploy-runbook.md 的 FR-6/红线补充,也不含 ledger.md 的 review 轮次记录。留痕生效前提是这些工作树改动最终落进提交,主会话收尾时需要一并处置(含 `plugin/.mcp.json` 的提交与否决策——按 :138 新登记,提交前必须先改回 npx)。
- `## 长期约束` 是 contracts.md deploy-runbook 四节之外的自增节。四个必含节(环境要求/部署步骤/回滚步骤/待确认红线)均在,不判违约;登记一句以免后续 pipeline-check 若加严格节校验时误报。

### 6.4 轮裁定

**全清,pass = true。** 3 条 Important 全部 ADDRESSED 且原缺陷不复存在(非"尝试过");修复 diff 为纯文档、零源码零配置改动,未引入 Critical/Important 破坏;新增 Minor-5/Minor-6 与上轮 4 条 Minor 同级,不阻塞收口,建议主会话择机一并处理。
