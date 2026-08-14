---
{task: T-A5, owner: backend-dev, worktree: false}
---

# T-A5 | FR-2:MCP stdio 代理路径三处同改(Validated / validate / handleProxy)

结构性事实(s1a facts.md F1,本卡最容易踩空的地方):`handleProxy` 是**重新构造 body 对象**而不是透传 `v`,只把字段加进 `validate` 白名单完全无效,三处必须一起改。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR2-1`(判据唯一事实源)。
- T-A1 产出的 schema 口子(MCP 客户端据此才允许传 `agentId`)。
- 落点文件既有 fetch 级 mock:`test/mcp-standalone-proxy.test.ts:8-14` 的 `installFetch()`(只替换 `globalThis.fetch`,`validate`/`handleProxy` 走真实代码;文件内 `#507` 用例已在断言 POST body 字段,照其写法)。
- 下游契约:`POST /agentmemory/remember` 的请求体由 T-A3(FR-5)负责解析 `agentId`;`project` 在该端点已被既有代码接受。

**Produces**
- `src/mcp/standalone.ts:96-108` `interface Validated`:新增 `agentId?: string`、`project?: string`(模块私有类型,无外部消费者)。
- `src/mcp/standalone.ts:116-126` `validate()` 的 `memory_save` 分支:白名单纳入两字段 —— `typeof args[k] === "string" && args[k].trim().length > 0` 才写入 `v`,否则不设(保持"缺省即 undefined")。
- `src/mcp/standalone.ts:175-186` `handleProxy()` 的 `memory_save` 分支:重建的 `JSON.stringify({...})` body 增补 `agentId: v.agentId`、`project: v.project`(`undefined` 键经 `JSON.stringify` 自动省略,符合边界要求)。
- `test/mcp-standalone-proxy.test.ts` 内新增 `FR-2 ` 前缀用例至少两条:①传 `agentId:"a1"`/`project:"p1"` 时 mock fetch 捕获的 `init.body` 解析后含该两字段;②两字段未传时 body 中不出现或为 `undefined`,既有 `#507` 相关断言不受影响。
- 落点硬约束:用例**只能**放 `test/mcp-standalone-proxy.test.ts`。放进 `test/mcp-standalone.test.ts` 会被 `instantLocalFallbackProbe` 把探针钉死 `ok:false` 强制走 `handleLocal`,永远进不了代理分支;`C-FR2-1` 的 cmd 只跑 proxy 文件,放错文件即零匹配即判红。

## 独占路径

- src/mcp/standalone.ts
- test/mcp-standalone-proxy.test.ts

## 覆盖 FR

- FR-2

## 验收用例

- `C-FR2-1`(cmd:`npx vitest run test/mcp-standalone-proxy.test.ts -t "FR-2 "`;expect_exit 0 且输出含 `Tests <n>= 2 passed`)
- 自证改前必红:先只加用例、不改三处实现,跑 `C-FR2-1` 应红(补丁前 body 只有 content/type/concepts/files)。
- 本期不做(design.md 已知限制,不在本卡范围):`standalone.ts:245-264` `handleLocal` 本地 fallback 写库仍不打 scope 标记。

## 依赖

- T-A4(依赖链串行)
- T-A1(schema 前置,design.md 依赖顺序节)
