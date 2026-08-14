---
{task: T-A4, owner: backend-dev, worktree: false}
---

# T-A4 | FR-4:MCP-over-REST 的 memory_save 分支转发 args.agentId

`POST /agentmemory/mcp/call` 的 `memory_save` 分支已处理 `project`(`src/mcp/server.ts:182-185`),唯独没有 `agentId`;同文件的 `memory_recall` 分支(116-129,#817)与 actions/messages 类工具(722/738/766/854)早已在做同一件事,本卡照既有约定补齐。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR4-1`(判据唯一事实源)。
- T-A1 产出的 schema 口子(不开则 `args.agentId` 恒 `undefined`,本卡功能对客户端不可达)。
- T-A1 产出的 `test/memory-scope-isolation.test.ts` 与其中 `mockKV()/mockSdk()/makeReq()`;驱动对象为真实 `registerMcpEndpoints`(`src/mcp/server.js`),调用形态照 `test/mcp-resources.test.ts` 既有用法。
- 照抄对象:`src/mcp/server.ts:120-123` `recallAgentId` 的解析写法(`typeof args.agentId === "string" && trim().length > 0 ? trim() : undefined`)。

**Produces**
- `src/mcp/server.ts:168-198` `memory_save` 分支:新增与 `project`(182-185)同构的 `agentId` 解析局部量,并以既有 `...(agentId !== undefined && { agentId })` 展开风格并入 `sdk.trigger({function_id:"mem::remember", payload})`;`content is required` 的 400 校验、`concepts`/`files` 的逗号分隔解析、200 返回形状不变。
- `test/memory-scope-isolation.test.ts` 内新增 `FR-4 ` 前缀用例至少两条:①`body={name:"memory_save", arguments:{content:..., agentId:"a1"}}` 时 `overrideTrigger("mem::remember")` 捕获的 payload 含 `agentId:"a1"`;②未传 `agentId` 时 payload 不含该字段,且既有 `project` 透传行为不受影响。

## 独占路径

- src/mcp/server.ts
- # 共享写入(非独占,依赖链串行):test/memory-scope-isolation.test.ts —— 只追加 `FR-4 ` 用例

## 覆盖 FR

- FR-4

## 验收用例

- `C-FR4-1`(cmd:`npx vitest run test/memory-scope-isolation.test.ts -t "FR-4 "`;expect_exit 0 且输出含 `Tests <n>= 2 passed`)
- 自证改前必红:先只加用例、不改实现,跑 `C-FR4-1` 应红。

## 依赖

- T-A3(依赖链串行,共享测试文件互斥)
- T-A1(schema 前置,design.md 依赖顺序节)
