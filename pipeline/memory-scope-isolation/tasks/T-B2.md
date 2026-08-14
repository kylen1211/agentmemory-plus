---
{task: T-B2, owner: devops-engineer, worktree: false}
---

# T-B2 | FR-7:MCP stdio 主路径切到工作树构建产物

与 T-B1 是**两个相互独立的进程**,各切各的(design.md ADR-2)。不采用覆盖 npx 缓存:`@agentmemory/mcp` 一发新版即被静默 reify 冲掉且无任何提示(facts.md F6 已用 npm 源码取证)。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR7-1`、`C-FR7-2`、`C-FR7-3`(判据唯一事实源;第三条标 `manual`)。
- T-B0 产出的 `/home/ky/git/source-project/agentmemory/dist/standalone.mjs`(内含 T-A5 的 FR-2 补丁)。
- `plugin/.mcp.json` 现状(s2a 实测):`command="npx"`,`args=["-y","@agentmemory/mcp"]`,`env` 三项为 `${AGENTMEMORY_URL:-...}` / `${AGENTMEMORY_SECRET:-}` / `${AGENTMEMORY_TOOLS:-all}`。

**Produces**
- 改后的 `plugin/.mcp.json`:`mcpServers.agentmemory.command="node"`,`args=["/home/ky/git/source-project/agentmemory/dist/standalone.mjs"]`;**`env` 三项原样保留**(`C-FR7-2` 按该 command/args 原样起进程并自行注入 URL/SECRET,改动 env 会打乱既有客户端行为)。
- 回退源:该文件受 git 跟踪,回退用 `git show HEAD:plugin/.mcp.json` 取原内容覆盖回去,不另建 `.bak` 文件(避免给仓库留未跟踪噪音);写入前把原内容打印进回执留痕(先留痕再写)。
- 回执写明:一次性探针 agentId(形如 `probe-msi-mcp-<ts>-<pid>`)与 `C-FR7-2` 读回的 `total`。

**待拍板阻塞项(design.md 风险 R-3,已入账 `act_msshmgwu`)**
- 实测本机在跑的 stdio server 是 `npm exec @agentmemory/mcp`(pid 1774621,父进程为 claude),而 `~/.claude/settings.json` 的 `enabledPlugins` 与 `installed_plugins.json` 指向插件缓存 `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json` —— 客户端实际加载的很可能不是本仓库这一份。
- 后果:只改仓库文件时 `C-FR7-1`/`C-FR7-2` 仍会绿(它们只证明配置与制品正确),但 `C-FR7-3` 的人工观察达不成。
- 本卡处置:**只改仓库内 `plugin/.mcp.json`(PRD FR-7 的字面范围)**;是否同改插件缓存那份或改用用户级 mcp 配置,属 `~/.claude` 域改动,须主会话/用户拍板后另行处置,本卡不擅自动 `~/.claude` 下任何文件。

## 独占路径

- plugin/.mcp.json

## 覆盖 FR

- FR-7

## 验收用例

- `C-FR7-1`(配置层:command 为 `node`、args 命中工作树 `dist/standalone.mjs`、该产物存在;expect_exit 0)
- `C-FR7-2`(制品层:照 `plugin/.mcp.json` 原样起进程走真实 MCP stdio 协议 initialize → notifications/initialized → tools/call memory_save,再按一次性 agentId 从 worker 读回 `total >= 1`;expect_exit 0)
- `C-FR7-3`(客户端层,`manual`:人工重启/重连宿主 MCP 客户端后发一次 memory_save 并核验落库带 agentId;`gen-contract.sh --dry-run` 已按 PARTIAL 登记,由主会话记 `uncovered` 处置,不阻塞本卡其余两条)
- 环境依赖:`C-FR7-2` 依赖本机 3111 端口 worker 已由 T-B1 拉起;worker 未起时红属环境不满足,不是本卡实现缺陷。

## 依赖

- T-B0(构建产物必须已是含补丁的新产物)
