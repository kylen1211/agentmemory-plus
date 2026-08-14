---
{task: T-A3, owner: backend-dev, worktree: false}
---

# T-A3 | FR-5:api::remember 接受 body.agentId(REST 写入路径)

`POST /agentmemory/remember` 是 `agent-mem` CLI 与 MCP stdio 代理的共同下游。当前请求体泛型与转发 payload 都没有 `agentId`,请求里传了也被静默丢弃。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR5-1`(判据唯一事实源)。
- T-A1 产出的 `test/memory-scope-isolation.test.ts` 与其中的 `mockSdk().getFunction(id)` / `overrideTrigger(id, handler)`。
- 照抄对象:`src/triggers/api.ts:605-609`(`api::session::start`)的解析写法 `typeof body.agentId === "string" && body.agentId.trim().length > 0 ? body.agentId.trim().slice(0,128) : undefined`。
- 下游兜底既有实现:`src/functions/remember.ts:102-105`(trim + `slice(0,128)` + `getAgentId()` 兜底)。
- 注册入口:`src/triggers/api.ts:138` `registerApiTriggers(sdk, kv, secret?)` —— 测试传 `secret` 为 `undefined` 时 `checkAuth`(39-52 行)直接放行,用例无需构造鉴权头。

**Produces**
- `src/triggers/api.ts:994-1035` `api::remember`:
  - 请求体泛型 `ApiRequest<{...}>` 新增 `agentId?: string`;
  - 新增局部解析(照抄 605-609 写法,得到 `string | undefined`);
  - `sdk.trigger({function_id:"mem::remember", payload:{...}})` 的 payload 沿用既有 `...(x !== undefined && { x })` 展开风格新增 `agentId`;
  - **本层不调用 `getAgentId()`**:env 兜底由 `remember.ts:102-105` 唯一承担,避免双重兜底导致行为分叉。
  - 既有 `project` 非空串 400 校验、`content is required` 校验、201 返回形状一字不改。
- `test/memory-scope-isolation.test.ts` 内新增 `FR-5 ` 前缀用例至少三条(`C-FR5-1` 的 `expect_out` 下限为 3):①正常长度 `agentId` 原样送达 `mem::remember` payload;②超过 128 字符时截断为恰好 128 字符;③缺失或空串时 payload 中该字段为 `undefined`/不出现且不报错。
- 用例形态硬约束:必须走 `sdk.getFunction("api::remember")` 直调 + `overrideTrigger("mem::remember")` 断言 payload;**禁止** `readFileSync` + 正则匹配源码文本的伪行为测试(`test/memories-pagination.test.ts` / `test/session-end-triggers-graph.test.ts` / `test/consistency.test.ts` 是这类写法,不可参照)。

## 独占路径

- src/triggers/api.ts
- # 共享写入(非独占,依赖链串行):test/memory-scope-isolation.test.ts —— 只追加 `FR-5 ` 用例

## 覆盖 FR

- FR-5

## 验收用例

- `C-FR5-1`(cmd:`npx vitest run test/memory-scope-isolation.test.ts -t "FR-5 "`;expect_exit 0 且输出含 `Tests <n>= 3 passed`)
- 自证改前必红:先只加三条用例、不改实现,跑 `C-FR5-1` 应红。

## 依赖

- T-A2(依赖链串行,共享测试文件互斥)
