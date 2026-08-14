---
{task: T-A2, owner: backend-dev, worktree: false}
---

# T-A2 | FR-1:memoryToObservation 透传 agentId/project(读侧转换)

业务后果不只是"字段没带上":检索索引的唯一入口是 `src/functions/remember.ts:145` 的 `getSearchIndex().add(memoryToObservation(memory))`,而 `src/functions/search.ts:543` 按 `obs.agentId` 硬过滤 —— 转换函数丢字段 → 索引里 `agentId` 恒 `undefined` → agentId 过滤生效时一条都命不中(design.md 现状盘点 §2)。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR1-1`(判据唯一事实源)。
- T-A1 产出的 `test/memory-scope-isolation.test.ts` 及其中的 mock 脚手架(本卡不重复新建该文件)。
- 数据源形状:`src/types.ts:83-105` `Memory`(本来就有 `agentId?: string` / `project?: string`,落库结构零变更)。

**Produces**
- `src/types.ts:46-64` `interface CompressedObservation` 新增 `project?: string`(additive optional,只增不改不删;`agentId?` 本已存在)。
- `src/state/memory-utils.ts:11` `memoryToObservation(memory: Memory): CompressedObservation` 返回体新增 `agentId: memory.agentId` 与 `project: memory.project` 两个字段:**值原样透传,不 trim、不填默认值、不做兜底**(截断与 env 兜底归 `remember.ts:102-105`,本层不重复)。
- `test/memory-scope-isolation.test.ts` 内新增 `FR-1 ` 前缀用例至少两条:①`Memory{agentId:"pm-agent", project:"worker-config"}` 转换后两字段值相等;②两字段为 `undefined` 时输出同为 `undefined`、不抛错、不出现任何默认值。

## 独占路径

- src/types.ts
- src/state/memory-utils.ts
- # 共享写入(非独占,依赖链串行):test/memory-scope-isolation.test.ts —— 只追加 `FR-1 ` 用例,不动 T-A1 落的 mock 脚手架与 FR-3 用例

## 覆盖 FR

- FR-1

## 验收用例

- `C-FR1-1`(cmd:`npx vitest run test/memory-scope-isolation.test.ts -t "FR-1 "`;expect_exit 0 且输出含 `Tests <n>= 2 passed`)
- 不回归:`memoryToObservation` 的既有 12 处调用点(3 个文件)对应测试由 T-A6 的 `C-REG-1` 统一复跑。
- 自证改前必红:先只加用例、不改实现,跑 `C-FR1-1` 应红。

## 依赖

- T-A1(共享测试文件与 mock 脚手架由该卡创建)
