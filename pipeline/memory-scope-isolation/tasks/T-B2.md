---
{task: T-B2, owner: devops-engineer, worktree: false}
---

# T-B2 | FR-7:两份 `.mcp.json` 同步切到工作树构建产物

作用对象已由用户 s2b 呈批拍板为**两份**(design.md ADR-2 / R-3):仓库 `plugin/.mcp.json`(发布态、受版本控制)与客户端实际加载的插件缓存那份(运行态、`~/.claude` 域、不受版本控制)。缓存那份让改动**当下生效**,仓库那份让改动**在下次插件更新后仍然生效**,缺一份就在某个时间点失效。与 T-B1 是两个相互独立的进程,各切各的。不采用覆盖 npx 缓存:`@agentmemory/mcp` 一发新版即被静默 reify 冲掉且无任何提示(facts.md F6 已用 npm 源码取证)。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR7-1`、`C-FR7-1b`、`C-FR7-2`、`C-FR7-3`(判据唯一事实源;第四条标 `manual`)。
- T-B0 产出的 `/home/ky/git/source-project/agentmemory/dist/standalone.mjs`(内含 T-A5 的 FR-2 补丁)。
- 仓库那份现状(s2a 实测,`plugin/.mcp.json`):`command="npx"`,`args=["-y","@agentmemory/mcp"]`,`env` 三项为 `${AGENTMEMORY_URL:-...}` / `${AGENTMEMORY_SECRET:-}` / `${AGENTMEMORY_TOOLS:-all}`。
- 缓存那份的定位方式(与 `C-FR7-1b` 保持同一套解析,防止"改的文件"和"判的文件"不是同一个):
  `P=$(jq -r '.plugins["agentmemory@agentmemory"][0].installPath // empty' ~/.claude/plugins/installed_plugins.json)`,取不到时回落 `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28`,目标文件为 `$P/.mcp.json`。s2b 现场实测该解析结果为 `/home/ky/.claude/plugins/cache/agentmemory/agentmemory/0.9.28`,与回落值一致。
- 缓存那份现状(s2a 实测):与仓库那份 `diff` 完全一致,是真实文件不是软链。

**Produces**
- 两份文件的目标态**逐字一致**:`mcpServers.agentmemory.command="node"`,`args=["/home/ky/git/source-project/agentmemory/dist/standalone.mjs"]`;**`env` 三项原样保留**(`C-FR7-2` 按该 command/args 原样起进程并自行注入 URL/SECRET,改动 env 会打乱既有客户端行为)。一致性由 `C-FR7-1b` 机器判定,人肉漂移会判红。
- 改法:用 `jq` 只替换 `command` 与 `args` 两个键后原地回写,保留文件其余键与 `env` 原文;不整体重写文件、不顺手格式化。
- 写前备份两份,**先备份再写**(坑库 P34,不做"先改了再拿 diff 给人看"),两份备份路径分开、互不覆盖:
  - 缓存那份(不受版本控制,备份是它唯一的本地回滚源)→ `/home/ky/.local/state/agentmemory-msi-mcp/plugin-cache-<版本号>.mcp.json.pre-msi.bak`(版本号取自上面解析出的 `installPath` 末段)。
  - 仓库那份 → `/home/ky/.local/state/agentmemory-msi-mcp/repo-plugin.mcp.json.pre-msi.bak`;备份落在仓库之外,不给仓库留未跟踪噪音,`git show HEAD:plugin/.mcp.json` 是它的等效第二回滚源。
  - 备份目录与 T-B1 的 `/home/ky/.local/state/agentmemory-msi` 是两个平行目录(独占路径互斥要求),不嵌套、不共用。
- 执行序列:解析缓存路径 → 备份两份 → 写仓库那份 → 写缓存那份 → 跑 `C-FR7-1`/`C-FR7-1b`/`C-FR7-2` → 人工重启/重连客户端做 `C-FR7-3`。
- `pipeline/memory-scope-isolation/deploy-runbook.md` 的 FR-7 小节留痕(design.md 组 B 边界条):部署步骤逐条写两份的备份绝对路径、两条写入命令与预期输出;回滚步骤逐条对应写两条回滚命令。本卡只写 FR-7 小节,不改 T-B1 负责的 FR-6 小节。
- 回执写明:两份文件写入前后的 command/args 实测值、两条备份文件绝对路径、一次性探针 agentId(形如 `probe-msi-mcp-<ts>-<pid>`)与 `C-FR7-2` 读回的 `total`。

**跨域边界与长期约束(ADR-2 已记账的代价)**
- 缓存那份位于 `~/.claude` 用户配置域、在仓库之外:不进本次 git diff、不进 review 的代码面,属**环境操作**,靠上面的 runbook 留痕与备份构成可追溯性。
- 本卡只写这两个 `.mcp.json` 与自己的备份目录;`~/.claude/settings.json`、`~/.claude/plugins/installed_plugins.json` 只读不写,`~/.claude` 下其它文件一律不动。
- 仓库那份随插件对外发布且写入了本机绝对路径,**发布前必须改回 `npx -y @agentmemory/mcp`**(R-3 约束①);本次不做自动拦截,作为长期注意事项交 s6 收尾登记。
- `/plugin` 更新或插件版本号变化(新建 `.../<新版本>/` 目录)会用仓库内容重新铺开缓存那份(R-3 约束②):仓库那份若仍是工作树路径则自动延续,若已按①改回则 FR-7 失效需重做本卡的缓存侧写入。`C-FR7-1b` 每轮 gate 复核,判红时先分辨是"实现没做"还是"做了之后被插件更新冲回"。

**回退路径(人工判断触发,不设自动判据 —— PRD 非目标 5)**
- 两份各自用对应备份覆盖回去(即 `command` 回 `"npx"`、`args` 回 `["-y","@agentmemory/mcp"]`),缓存那份另有"重装插件"这条等效退路;除这两个文件外无其它状态需还原。
- 两份可单独回滚,但**只回滚一份会造成发布态与运行态不一致**:要么同回,要么在回执里写明只回一份的理由与后续处置。

## 独占路径

- plugin/.mcp.json
- /home/ky/.claude/plugins/cache/agentmemory/agentmemory
- /home/ky/.local/state/agentmemory-msi-mcp

## 覆盖 FR

- FR-7

## 验收用例

- `C-FR7-1`(配置层·仓库:`plugin/.mcp.json` 的 command 为 `node`、args 命中工作树 `dist/standalone.mjs`、该产物存在;expect_exit 0)
- `C-FR7-1b`(配置层·运行态:`installed_plugins.json` 指向的那份 `.mcp.json` 同样指向工作树产物,且与仓库那份 command/args 逐字一致;expect_exit 0。这条同时是"插件更新把缓存那份铺回旧内容"的探测器)
- `C-FR7-2`(制品层:照 `plugin/.mcp.json` 原样起进程走真实 MCP stdio 协议 initialize → notifications/initialized → tools/call memory_save,再按一次性 agentId 从 worker 读回 `total >= 1`;expect_exit 0。守卫要求 command 为 `node` 且 args 命中工作树产物才起进程,避免误触发 `npx` 联网安装)
- `C-FR7-3`(客户端层,`manual`:人工重启/重连宿主 MCP 客户端后发一次 memory_save 并核验落库带 agentId,观察时点须确认两份文件都仍指向工作树产物;`gen-contract.sh --dry-run` 已按 PARTIAL 登记,由主会话记 `uncovered` 处置,不阻塞本卡其余三条)
- 环境依赖:`C-FR7-2` 依赖本机 3111 端口 worker 已由 T-B1 拉起;worker 未起时红属环境不满足,不是本卡实现缺陷。
- 已知副作用(design.md 风险 R-4,已被用户接受):`C-FR7-2` 每跑一轮向真实记忆库写入一条 `concepts` 含 `pipeline-probe` 的探针记录;清理属破坏性操作,须先列清单交人确认后再删,不进自动化。

## 依赖

- T-B0(构建产物必须已是含补丁的新产物)
