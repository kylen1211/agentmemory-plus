## 关键问题清单

1. 本次范围是否包含把共享函数 `validate()`(src/mcp/standalone.ts:112-178)里 `memory_recall`/`memory_smart_search` 分支补上 `agentId`/`project` 参数解析?
   为何影响方案走向:现状只有 `memory_save` 分支(standalone.ts:127-134)从 `args` 读取并写入 `v.agentId`/`v.project`;`memory_recall`/`memory_smart_search` 分支(standalone.ts:137-157)完全不读取这两个参数,即便 `Validated` 接口(standalone.ts:96-110)已声明字段。若不改 `validate()`,`handleLocal` 里给 recall/smart_search 加的过滤逻辑永远拿不到 `v.agentId`/`v.project`,补丁等于空转。`validate()` 是 `handleLocal` 与 `handleProxy` 共用的同一函数,改动会同时影响两条路径,需要拍板是否在此任务里一并改。
   答复:(待回填)

2. `agentId` 的过滤语义要对齐 server 端(`src/functions/search.ts:370-410`、`src/functions/smart-search.ts`)的"仅当 `AGENTMEMORY_AGENT_SCOPE=isolated` 时启用、回落 env `AGENT_ID`、`"*"` 通配符绕过、isolated 且取不到 agentId 时 fail-closed 拒绝返回"这套完整模型,还是采用更简单的"传了 agentId 就精确过滤,没传就不过滤"?
   为何影响方案走向:两种语义验收判据完全不同。若对齐 server 端,需要 `handleLocal` 所在的 `src/mcp/standalone.ts` 新增 import `config.ts` 的 `isAgentScopeIsolated()`/`getAgentId()`(现状完全没 import,已用 codegraph 核实);若用简化版,会导致同一 MCP 工具在"server 可达走代理"与"server 不可达走本地兜底"两种模式下过滤行为不一致(用户体感不同)。这决定改动要不要引入新依赖以及验收用例覆盖哪些场景。
   答复:(待回填)

3. `project` 过滤要不要对老数据做向后兼容放行?server 端对 `project` 是无条件精确匹配,但对"project 字段未知/无法判定"的历史记录采取"放行、当作 unscoped"的策略(`src/functions/search.ts:507-511` 注释明确写"a null memProject means project unknown — treat as unscoped and let it through to preserve backward-compatibility")。`handleLocal` 的持久化记录里现有字段集(standalone.ts:260-273)本来就没有 `agentId`/`project`,升级后已存在的本地旧记录这两个字段必然是 `undefined`。
   为何影响方案走向:如果新过滤逻辑对"字段缺失"按"不匹配"处理,老用户升级后 `memory_recall` 会突然看不到自己之前存的所有本地记忆(体验回归);如果按"放行"处理,则要在 PRD 里显式写这条兼容判据,且验收用例要覆盖"无 project/agentId 字段的旧记录"这一案例。
   答复:(待回填)

4. `handleProxy` 里 `memory_recall`/`memory_smart_search` 转发 REST 请求体(standalone.ts:199-221)目前同样没有带上 `agentId`/`project`,即便 REST `/agentmemory/search` 端点本身已支持这两个参数(`src/triggers/api.ts:388-460`)——这条并行缺口是否属于本任务范围,还是明确排除、留给另一个 change?
   为何影响方案走向:背景材料里"对照组…把 agentId/project 的透传与隔离做到了 server 代理路径"这句话容易被理解为"代理路径的 recall/search 也已经补齐",但现场读码(以及 `git log` 核实:上一轮 memory-scope-isolation 的 FR-2/T-A5 提交信息明确写的是"MCP stdio proxy forwards agentId/project **on memory_save**")显示代理路径的 recall/search 分支从未被补过。不澄清,PRD"非目标"一节写不清楚,下游可能误以为这条已经在别处覆盖。
   答复:(待回填)

5. 除 `memory_save`/`memory_recall`/`memory_smart_search` 外,`handleLocal` 还覆盖 `memory_sessions`/`memory_governance_delete`/`memory_export`/`memory_audit` 四个分支(standalone.ts:301-343)。任务原话只说"补 agentId/project",未限定到具体哪几个工具——这四个分支要不要也纳入隔离范围(例如 `memory_export`/`memory_audit` 目前会导出/审计全部本地数据、不分 agent;`memory_governance_delete` 目前允许跨 agent 删除)?
   为何影响方案走向:决定 PRD 需求清单的 FR 编号范围和验收覆盖面;不明确会导致 P0/P1 划分随意,且遗漏的分支会在 review 阶段被追问"为什么没做"。
   答复:(待回填)

## 风险与未验事实清单

1. 命题:实际生产环境中,`getStandalonePersistPath()` 对应的本地持久化文件(handleLocal 使用的 InMemoryKV persist 目标)当前是否已有真实历史数据、量级多大。
   Cagan 分类:可行性
   为何未验:超出只读单点核验范围(需要探测用户本机实际数据文件内容/大小,且与"字段结构能不能加"无关);codegraph 只能核实代码逻辑,读不到运行时持久化文件状态。留给 s1a 调研阶段决定是否需要实测。

2. 命题:是否存在具体的故障/投诉实例(而非纯粹对照 memory-scope-isolation 做完整性补漏)——即"本地兜底模式下 memory_recall 混进了别的 agent/project 记忆"这一问题曾被真实观察到。
   Cagan 分类:价值
   为何未验:任务来源(act_mssnp1ji)原话是"本地兜底路径补 agentId/project"这一方案陈述,未附任何具体触发场景或用户反馈;背景材料也只给了代码现状对比,没有故障记录。证据分级=假设,需向用户或主会话核实。

3. 命题:本地兜底模式(纯 npx 运行、server 不可达)的实际触发频率/影响的用户规模——如果这条路径只在 server 短暂不可达的窗口期生效,补齐隔离的优先级判断依据是什么。
   Cagan 分类:价值
   为何未验:没有遥测/使用数据可查,只读取数通道(codegraph/agent-mem/tvly/firecrawl)覆盖不到运行时使用频率统计,需用户或产品侧提供。

4. 命题:若问题 2 拍板要对齐 server 端 gated + fail-closed + wildcard 语义,`src/mcp/standalone.ts` 新增 import `config.ts` 的 `isAgentScopeIsolated`/`getAgentId` 后,是否会把这个目前依赖很轻的 CLI 入口文件引入 `config.ts` 内部更深的依赖链(进而放大改动的影响面)。
   Cagan 分类:成本
   为何未验:codegraph 单点核验只确认了 `standalone.ts` 当前未 import 这两个函数(证据充分),但未展开 `config.ts` 自身的完整依赖图——超出 s1a 取证轮"判断需要知道什么"的范围,留给 s1b/tech-architect 在设计阶段展开评估是否影响 s0 已判定的 L1 分级。
