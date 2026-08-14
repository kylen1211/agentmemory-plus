---
debts:
  - {id: D-001, desc: "npx tsc --noEmit 全仓基线即有25条类型错误(src/providers/openai.ts 未用变量、src/state/index-persistence.ts unknown类型、src/triggers/api.ts 三处),与 memory-scope-isolation 变更(FR-1~FR-7)无关——在 base_commit(d60652a7)与当前 HEAD 之间逐条比对错误集合完全一致(仅因本变更在 api.ts 插入代码导致2条错误行号平移9行,内容不变),s4m 合并闸门 typecheck 项因此恒红,已由主会话核实为项目基线债务,不阻塞本次变更", module: src, ttl: 2026-11-12, source: memory-scope-isolation}
  - {id: D-002, desc: "test/consistency.test.ts 断言 README.md/AGENTS.md/CLAUDE.md 中记录的 REST 端点数与源码实际端点数一致,当前基线本身已漂移(README 文档数字滞后于代码),与 memory-scope-isolation 变更代码无关——在 base_commit(d60652a7)复现同样失败,s4m 合并闸门 tests 项已通过 GATE_TEST_CMD 追加 --exclude test/consistency.test.ts 规避,需要专人核对四份文档实际端点数并回填", module: test/consistency.test.ts, ttl: 2026-11-12, source: memory-scope-isolation}
---
