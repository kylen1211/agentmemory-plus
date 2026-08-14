---
{task: T-B1, owner: devops-engineer, worktree: false}
---

# T-B1 | FR-6(D10):systemd 切到工作树构建产物并真实生效

只改配置指向,不改安装内容(design.md ADR-1)。**`ExecStart` 与 `ExecStopPost` 两行同改** —— 只改 `ExecStart` 会出现"新码启动、旧码停止"的混搭(facts.md F4);`WorkingDirectory=%h/.agentmemory` 与 `EnvironmentFile` 不动。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR6-1`、`C-FR6-2`(判据唯一事实源)。
- T-B0 产出的 `/home/ky/git/source-project/agentmemory/dist/cli.mjs`。
- 单元文件现状(s2a 实测,`~/.config/systemd/user/agentmemory.service`):
  - 第 11 行 `ExecStart=%h/.local/bin/node %h/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs --verbose`
  - 第 12 行 `ExecStopPost=-%h/.local/bin/node %h/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs stop --force`
- 鉴权:`C-FR6-2` 取 `AGENTMEMORY_SECRET`,未设时从 `~/.config/agentmemory/service.env` 读;卡内与回执均不得出现真实密钥值。

**Produces**
- 改后的 `~/.config/systemd/user/agentmemory.service`:两行的 node 参数路径均替换为 `/home/ky/git/source-project/agentmemory/dist/cli.mjs`,各自的后续参数(`--verbose` / `stop --force`)与 `ExecStopPost` 行首的 `-` 前缀保持原样。
- 写前备份(坑库 P34,先备份再写,不做"先改了再拿 diff 给人看"):原文件复制到 `~/.local/state/agentmemory-msi/agentmemory.service.pre-msi.bak`(放在 systemd 扫描目录之外,避免被当作单元文件)。
- 执行序列:备份 → 改两行 → `systemctl --user daemon-reload` → `systemctl --user restart agentmemory` → `systemctl --user is-active agentmemory` → `curl /agentmemory/livez`。
- 回执写明:一次性探针 agentId(形如 `probe-msi-rest-<ts>-<pid>`)、`C-FR6-2` 读回的 `total`、以及本次重启的实际时刻。

**回退路径(人工判断触发,不设自动判据 —— PRD 非目标 5)**
- 服务不 `active` 或 `livez` 不通 → 用备份覆盖回单元文件 → `daemon-reload` → `restart`;除这两行外无其它状态需要还原(全局包目录本次不动)。

## 独占路径

- /home/ky/.config/systemd/user/agentmemory.service
- /home/ky/.local/state/agentmemory-msi

## 覆盖 FR

- FR-6

## 验收用例

- `C-FR6-1`(unit 两行均指向工作树 `dist/cli.mjs`、服务 active、livez 返回 200;expect_exit 0)
- `C-FR6-2`(真实 REST 写入一条带一次性 agentId 的记忆后按该 agentId 读回 `total >= 1`,证明跑的是补丁后的代码;expect_exit 0)
- 已知副作用(design.md 风险 R-1/R-4,均已被用户接受):重启窗口约 15 秒内的写入可能丢失,不设安静窗口、不额外防护;`C-FR6-2` 每跑一轮向真实记忆库写入一条 `concepts` 含 `pipeline-probe` 的探针记录,清理属破坏性操作,须先列清单交人确认后再删,不进自动化。

## 依赖

- T-B0(构建产物必须已是含补丁的新产物)
