## 关键问题清单

1. **D10 分支起点怎么定**:源码仓库当前 HEAD=`d60652a`,相对 `origin/main` 领先 1(本次 pipeline 自身的 ledger commit `acb7772`)、落后 2(上游两个新提交);工作区还有未提交的 `pipeline/memory-scope-isolation/ledger.md` 改动,以及两个与本次任务无关的未跟踪文件(`SCHEDULING-AND-EVICTION-NOTES.md`、`.gitattributes`)。四处补丁要基于当前 HEAD 直接开新分支改,还是先同步 `origin/main` 再改?那两个无关的未跟踪文件要不要先隔离,避免混进补丁 diff?→ 决定补丁分支的起点与改动边界是否干净。

2. **构建产物怎么"重指"**:`npm run build`(`tsdown`)产出到 `dist/`,该目录当前不存在(仓库从未构建过)。现有 systemd `ExecStart` 硬编码指向 nvm 全局 `node_modules/@agentmemory/agentmemory/dist/cli.mjs`。是把 `ExecStart` 改指向本仓库工作树里新建的 `dist/cli.mjs` 绝对路径,还是用 `npm link`/直接覆盖全局包目录内容?两种方式"以后改 `src/**` 是否需要重新 build 才生效"以及回滚脚本怎么写不一样。→ 决定 D10 的具体落地步骤。

3. **npx 缓存"同步替换"具体替换哪一份、怎么替换**:实测本机 `~/.npm/_npx/` 下同时有两个哈希目录都解析到 `@agentmemory/agentmemory@0.9.28`——`895ddc906593189f`(2026-08-02 建,`_npx.packages` 锁了 `@agentmemory/mcp@0.9.28`)与 `ba4b5775a0ab44e2`(2026-08-14 建,`_npx.packages` 是未锁版本的 `@agentmemory/mcp`,与当前 `plugin/.mcp.json` 里 `npx -y @agentmemory/mcp` 的精确参数一致,应是实际生效那份)。"替换"是指手工覆盖这份目录下 `dist/standalone.mjs` 文件本身,还是有更稳妥的机制(比如强制 npx 忽略缓存重新安装)?手工覆盖裸文件后,下次触发 `npx -y` 会不会被静默重装冲掉,取决于 npx 判定缓存新鲜度的机制,这点没查过。→ 这是四处补丁里第 2 处(真 MCP 主路径)能否稳定生效的最大不确定点。

4. **验收是否需要按三条写入路径分别补用例**:现有 `evidence/scope-isolation.sh` 用 `POST /agentmemory/import` 直接往库里注入数据,完全绕开三条写入路径,只验证了补丁 1(读侧 `memoryToObservation`)。上游两个测试文件里,`agent-id-scope.test.ts` 测的是 `mem::remember` 底层函数本身(该函数本来就支持 `agentId`,不是本次要修的对象);`agent-isolation-search.test.ts` 测 `mem::search` 时是直接往 `KV.observations` 种数据,同样没有经过任何写入侧代码。也就是说,补丁 2(`standalone.ts`)/ 补丁 3(`server.ts`)/ 补丁 4(`api.ts`)三处写侧改动,目前没有任何一条自动化验收会真正触达。是需要针对三条路径各补一条端到端用例(真实调用对应 handler/端点),还是维持现有验收范围、书面承认这块暂不覆盖?→ 直接决定"改完怎么证明改对了",是本次任务能否判定完成的核心判据。

5. **四处补丁改动范围是否已查全**:README 只对补丁 1(`memoryToObservation`)做过 codegraph blast-radius 检查(3 文件 12 处调用、4 个既有测试覆盖);补丁 2/3/4 对应的白名单/转发逻辑(`standalone.ts` 白名单、`server.ts` memory_save 分支+`tools-registry.ts:55` schema、`api.ts` `api::remember`)有没有做过同等排查,确认没有第五处遗漏点(比如白名单逻辑是否在别处被复用)?

6. **D10 切换过程中服务中断/数据风险的可接受范围**:本机是唯一部署,主会话与所有子 agent 实时依赖它运行。整套改造至少需要一次 `systemctl restart` 让新 `ExecStart` 生效;P9(重启后约 15 秒缓冲窗口内的写入可能丢失)已判定"接受现状",但那是针对"日常场景触发概率低"的评估,这次是主动、可预期的重启。是否需要选定一个明确执行窗口(比如确认重启前没有正在进行的写入)?重启期间(几秒到数十秒服务不可用)子 agent 写入失败是否需要提前告知,还是按现有重试机制静默处理即可?

7. **回滚判据与彻底性**:提到"回滚到 0.9.28 全局包运行,路径要清楚",但具体动作范围没定——是只需把 `ExecStart` 改回原值再重启,还是也要把补丁 2 手工覆盖过的 npx 缓存文件复原(需要提前备份原始 `dist/standalone.mjs`)?触发回滚的判据是什么(某几项验收失败即回滚,还是人工判断)?

## 风险与未验事实清单

- **命题**:把 `ExecStart` 指向源码工作树构建出的 `dist/cli.mjs` 绝对路径,可以正常拉起 worker,且运行行为与当前全局包版本一致(无相对路径/环境依赖差异)。
  **依据**:可行性。
  **为何未验**:`dist/` 目前不存在,仓库从未实际跑过一次 `npm run build`;`cli.mjs` 内部是否有依赖 `WorkingDirectory`/`__dirname` 之类相对路径解析(例如定位 `~/.agentmemory/bin/iii`)在切换安装位置后是否有差异,没有查证,更没有做过一次实际构建+拉起+探活的端到端验证。

- **命题**:手工覆盖 npx 缓存目录(`ba4b5775a0ab44e2`)下的 `dist/standalone.mjs` 后,补丁会持续生效,不会被后续 `npx -y @agentmemory/mcp` 调用静默重装覆盖回原版本。
  **依据**:可行性。
  **为何未验**:只查了该目录当前内容与 mtime、`_npx.packages` 字段,没有做过"手工改动后再真实触发一次 MCP 连接(比如重启 Claude Code)"的实测,不确定 npx 判定缓存新鲜度/是否联网核对 registry 版本号的具体机制。

- **命题**:针对三条写入路径(`standalone.ts`/`server.ts`/`api.ts`)分别补的端到端验收用例,能在现有 vitest + mock 测试基础设施下直接扩展,不需要额外起真实服务或大改测试骨架。
  **依据**:可行性 / 可用性(现有验收资产能否被下游直接复用)。
  **为何未验**:已定位到 `test/mcp-standalone.test.ts`、`test/mcp-standalone-proxy.test.ts` 等现存文件确实覆盖到这几处代码,但各自的 mock 边界(是否已经 mock 掉了要验证的白名单/转发逻辑本身,导致补的断言测不出真实 bug)没有逐一读过。

- **命题**:D10 切换期间那一次 `systemctl restart` 造成的服务中断时长,在用户可接受范围内。
  **依据**:成本。
  **为何未验**:没有问过用户可接受的中断时长上限;也没有单独实测过"改 `ExecStart` 后冷启动到 `livez` 返回 200"需要多久——`evidence/scope-isolation.sh` 里等待的 120 秒超时窗口是索引重建耗时,不是纯冷启动耗时,两者不能直接当同一个数拿来用。

- **命题**:回滚到当前 0.9.28 全局包运行,只需把 `ExecStart` 改回原值即可,不需要额外还原 npx 缓存或其它状态。
  **依据**:成本 / 可行性。
  **为何未验**:目前只锁定了"`ExecStart` 改动"这一个可回滚变量,但补丁 2 需要动 npx 缓存里的裸文件,若回滚只改 `ExecStart` 而不复原 npx 缓存里被覆盖的 `standalone.mjs`,MCP 工具侧会残留改动过的代码——这条回滚链路目前没有梳理过,也没有确认是否需要提前对该文件做备份。

- **命题**:现有 4 处补丁改动范围完整,不存在遗漏的第五处代码位置。
  **依据**:可行性。
  **为何未验**:README 用 codegraph 排查过的只有补丁 1(`memoryToObservation`,3 文件 12 处调用、4 测试覆盖);补丁 2/3/4 对应的白名单/转发逻辑(`standalone.ts` 白名单、`server.ts` 分支+`tools-registry.ts:55` schema、`api.ts` `api::remember`)没有做过同等的 blast-radius 检查,不确定这几处白名单裁剪逻辑是否在别的端点/工具里被复用而未被列入必改清单。

## 用户已答复(2026-08-14,关键问题清单批复)

- **Q4(验收范围)** → **补齐三路径用例**:针对写入路径(`standalone.ts`/`server.ts`/`api.ts`)分别补端到端验收用例,不满足于现有 scope-isolation.sh + 读侧测试;这是本次 contract_tier=cases 的验收用例清单必须覆盖的范围,s2a/s2b 据此设计。
- **Q2(ExecStart 重指方式)** → **指向工作树构建产物**:`ExecStart` 直接指向仓库工作树里 `npm run build` 产出的 `dist/cli.mjs` 绝对路径,不用 npm link / 覆盖全局包;意味着以后改 `src/**` 需要重新 build 才生效,回滚只需把 `ExecStart` 改回原全局包路径。
- **Q7(回滚判据)** → **人工判断**:不预设自动触发回滚的判据,出问题时由用户现场决定是否回滚;不需要在验收脚本里做自动回滚联动。
- **Q6(重启窗口)** → **直接执行不特别处理**:D10 切换所需的 `systemctl restart` 不额外选定安静窗口、不提前告知子 agent,按现有重试机制处理;P9 的 15 秒缓冲窗口丢数据风险维持"接受现状"的既有判定,不为这次主动重启加码防护。

Q1(分支起点)、Q3(npx 缓存替换机制)、Q5(补丁 2/3/4 blast-radius 是否查全)、Q7 的机制细节(npx 缓存要不要备份)仍是技术机制问题,不需要用户拍板,转入 `research/facts.md` 实测预检环节核验。

## 用户已答复(2026-08-14,实测预检发现后的第二轮批复)

tech-architect 盘点(`codebase-survey.md`/`facts.md`)证伪了原始"四处必改清单",发现补丁 2 实为三处同改 + 新增必改点 5b(`tools-registry.ts` schema)+ `ExecStopPost` 同改——这些是硬事实,已直接采纳进 s2 范围,不是用户选择项。以下三项是呈用户拍板后的结论:

- **5c(handleLocal 本地 fallback 不带 scope)** → **本期不修**。用户拍板原则:"小的细节如果后面可以用脚本或其他解耦方式实现,本期可以不做,本期只做重点的核心功能跟架构,保持良好的扩展跟兼容性,不需要一次性做全"。5c 仅在 worker 服务不可达时触发(与 P7 影子库同一条路径,P7 本身已判定接受现状),日常主路径不经过,归为**已知限制**,design.md 需书面记录,不列入本期验收范围,后续如需可用独立脚本补做。
- **MCP stdio 补丁生效方式** → **改 `.mcp.json` 指向工作树构建产物**(`node .../dist/standalone.mjs`),不采用手工覆盖 npx 缓存的方案。理由:手工覆盖有确定的失效窗口(上游一发新版 `@agentmemory/mcp` 到 registry 就会被 npx 静默 reify 冲掉,且无任何提示),而改 `.mcp.json` 与 D10 对 systemd 的做法同构,回滚只需改回 `npx -y @agentmemory/mcp`,不存在被上游发版冲掉的风险。s2a 据此设计 `.mcp.json` 改动方案。
- **分支起点** → **基于当前 HEAD(`acb7772`)直接开新分支**,不先同步 origin/main。理由:落后的 v0.9.29(`9c82d2a`)与四处补丁目标文件实测零重叠、且没有修本 bug;基于当前 HEAD 能把 D10 重启的变量隔离到"只改作用域补丁"一个维度,便于日后归因;后续再补同步 origin/main 的成本不变。
