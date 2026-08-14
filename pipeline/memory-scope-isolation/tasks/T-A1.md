---
{task: T-A1, owner: backend-dev, worktree: false}
---

# T-A1 | FR-3:memory_save inputSchema 开放 agentId + 重生成技能参考文档

组 A 首卡:最上游的 schema 口子,不开则 T-A4/T-A5 拿到的 `args.agentId` 恒为 `undefined`(design.md 依赖顺序节)。本卡同时新建组 A 共享测试文件与其 mock 脚手架。

## Interfaces

**Consumes**
- `contract/cases.md` 的 `C-FR3-1`、`C-FR3-2`(判据唯一事实源,不得改动该文件)。
- 既有 schema 字段风格:`src/mcp/tools-registry.ts:424/440/452/515` 的 `agentId: { type: "string", description: ... }`(照抄,不自创写法)。
- 文档生成器:`scripts/skills/generate.ts:68-84` 从 `inputSchema.properties` 生成参数表;`npm run skills:gen` / `npm run skills:check`(package.json:28-29)。
- mock 脚手架原件:`test/mcp-resources.test.ts:10-66` 的 `mockKV()` / `mockSdk()` / `makeReq()`。

**Produces**
- `src/mcp/tools-registry.ts:55-87` `memory_save.inputSchema.properties` 新增 `agentId: { type: "string", description: <说明该记忆归属哪个 agent 角色> }`;`required` 保持 `["content"]` 不变,工具条目总数不变,`getAllTools()` 签名不变。
- 重生成后的 `plugin/skills/agentmemory-mcp-tools/REFERENCE.md`(由 `npm run skills:gen` 产出,人工不手改)。
- 新建 `test/memory-scope-isolation.test.ts`,文件内自带三个函数(照抄上述原件,后续 T-A2/T-A3/T-A4 直接复用,不再各自新建):
  - `mockKV()`:内存 KV。
  - `mockSdk()`:必须带 `overrideTrigger(id, handler)` 与 `getFunction(id)` 两个方法 —— T-A3 用 `getFunction("api::remember")` 直调、T-A4/T-A3 用 `overrideTrigger("mem::remember", h)` 捕获 payload。
  - `makeReq(body?, headers?)`。
- 该文件内新增 `FR-3 ` 前缀用例(describe+it 拼接后的全名以 `FR-3 ` 开头,含末尾空格),至少两条:①`getAllTools()` 取 `memory_save` 的 `inputSchema.properties.agentId.type === "string"`;②`required` 仍为 `["content"]` 且工具总数与改前一致。

## 独占路径

- src/mcp/tools-registry.ts
- plugin/skills/agentmemory-mcp-tools/REFERENCE.md
- # 共享写入(非独占,由 T-A1→T-A2→T-A3→T-A4→T-A5 依赖链串行保证互斥):test/memory-scope-isolation.test.ts —— 本卡创建该文件并落 mock 脚手架 + FR-3 用例,后续卡只在其中追加自己的 FR-N 用例,不改他卡用例

## 覆盖 FR

- FR-3

## 验收用例

- `C-FR3-1`(cmd:`npx vitest run test/memory-scope-isolation.test.ts -t "FR-3 "`;expect_exit 0 且输出含 `Tests <n>= 2 passed`)
- `C-FR3-2`(cmd:`npm run skills:check`;expect_exit 0 —— 改 schema 不跑 `skills:gen` 会判 DRIFT)
- 自证改前必红:先只加用例、不改 schema,跑 `C-FR3-1` 应红;再加 schema 转绿。

## 依赖

无
