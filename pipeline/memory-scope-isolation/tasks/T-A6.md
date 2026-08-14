---
{task: T-A6, owner: backend-dev, worktree: false}
---

# T-A6 | 组 A 收口:回归子集复跑(C-REG-1)

全量 `npm test` 在本机基线本身就红(s2a 实测 12 失败 / 5 文件,11 条源于 `~/.agentmemory/.env` 泄漏进测试进程、1 条是 HEAD 上 README 端点计数漂移,均与本次改动无关 —— design.md 风险 R-2)。因此组 A 的回归判据落在一个**基线实测全绿、且与五处补丁直接相关**的九文件子集上。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-REG-1`(判据唯一事实源,九个测试文件清单以其 cmd 为准,不增不减)。
- T-A1~T-A5 全部落地后的主工作树代码。
- 覆盖面构成:schema 消费方 3(`mcp-standalone` / `mcp-surface-default` / `tool-count-consistency`)+ `memoryToObservation` 消费方 3(`governance` / `remember-forget-audit` / `agent-id-scope`)+ 作用域读侧(`agent-isolation-search`)+ MCP 两条路径(`mcp-resources` / `mcp-standalone-proxy`)。

**Produces**
- 一次 `C-REG-1` 的实跑结果(命令 + 退出码 + `Test Files 9 passed` 输出行),写进本卡回执,不落文件。
- 若出现回归红:**本卡不改任何源码**(源码路径归 T-A1~T-A5 独占),按红在哪个文件回报主会话,由其回派对应卡修复。

## 独占路径

- # 无可写路径:本卡只做只读复跑,不新增、不修改任何文件

## 覆盖 FR

- 无新增 FR;C-REG-1 保护 FR-1 ~ FR-5 五处补丁所触及的既有资产不被打坏

## 验收用例

- `C-REG-1`(cmd:`npx vitest run test/mcp-standalone.test.ts test/mcp-surface-default.test.ts test/tool-count-consistency.test.ts test/governance.test.ts test/remember-forget-audit.test.ts test/agent-isolation-search.test.ts test/agent-id-scope.test.ts test/mcp-resources.test.ts test/mcp-standalone-proxy.test.ts`;expect_exit 0 且输出含 `Test Files 9 passed`)
- 附带复跑 `C-FR1-1`/`C-FR2-1`/`C-FR3-1`/`C-FR3-2`/`C-FR4-1`/`C-FR5-1` 六条,确认组 A 五处补丁在同一份工作树上同时为绿(单卡各自绿不等于合到一起仍绿)。

## 依赖

- T-A5(组 A 依赖链末端;T-A1~T-A5 必须全部 DONE)
