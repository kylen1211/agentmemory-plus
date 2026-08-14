---
{task: T-B0, owner: devops-engineer, worktree: false}
---

# T-B0 | 组 B 前置:在主工作树构建含补丁的 dist 产物

硬前置且不可省:`dist/` 被 `.gitignore` 排除、不随代码合并自动更新。不重新构建,T-B1/T-B2 切过去的仍是旧产物 —— 这正是 `C-FR6-2`/`C-FR7-2` 要抓的"配置改了但代码没生效"(design.md 依赖顺序节)。

## Interfaces

**Consumes**
- 组 A 全部合入**主工作树**后的 `src/**`(T-A6 DONE 是本卡的准入条件;在子工作树里构建会把没有补丁的产物切过去)。
- 构建命令:`npm run build`(package.json:20,`tsdown` + 若干静态文件拷贝)。
- 构建耗时基线:s1a build-spike 实测 4.583s,`dist/cli.mjs` 105,446 字节。

**Produces**
- `dist/cli.mjs`(T-B1 的 systemd `ExecStart`/`ExecStopPost` 目标)与 `dist/standalone.mjs`(T-B2 的 MCP stdio 目标),均为含五处补丁的新产物。
- 一份"产物确实含补丁"的实跑证据写进回执:构建后 `grep -c agentId dist/standalone.mjs` 非零,且产物 mtime 晚于 `src/mcp/standalone.ts` 的 mtime。
- 构建副作用复原:`npm run build` 会给 `plugin/scripts/*.mjs` 等加可执行权限位(build-spike 附录),产生与本次无关的 `git status` 噪音 —— 构建后核对并复原权限位,不让它混进补丁 diff。

**长期约束(交付给 T-B1/T-B2 与 s6 收尾)**
- `tsdown.config.ts` 的 `deps.neverBundle` 含 `@huggingface/transformers` 等三个包,产物运行时依赖**同工作树的 `node_modules/`**(facts.md F3)。T-B1 生效后,主工作树的 `dist/` 与 `node_modules/` 升格为生产依赖:不得删除、不得 `git clean -xdf`,否则 worker 下次重启起不来。

## 独占路径

- dist
- plugin/scripts

## 覆盖 FR

- 无(FR-6 与 FR-7 的共同前置构建步骤,自身不直接对应验收用例)

## 验收用例

- 本卡无独立用例;产物正确性由下游 `C-FR6-1`/`C-FR6-2`(T-B1)与 `C-FR7-1`/`C-FR7-2`(T-B2)判定 —— 那四条中任意一条因"产物是旧的"而红,红点归本卡。
- 卡内自检(结果写回执):`ls -l dist/cli.mjs dist/standalone.mjs` + 上述 mtime/grep 两项证据 + `git status --porcelain` 无权限位噪音残留。

## 依赖

- T-A6(组 A 全部合入主工作树并回归通过)
