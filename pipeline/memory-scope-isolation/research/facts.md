# facts — memory-scope-isolation(s1a 实测预检)

## 已核验事实

### F1 | 补丁 2/3/4 改动范围**不完整**,存在第五、六、七处遗漏点

- **待验命题**:现有 4 处补丁改动范围完整,不存在遗漏的第五处代码位置。
- **命令**:
  - `mcp__codegraph__codegraph_explore(query="validate handleProxy handleLocal handleToolCall standalone memory_save Validated interface callers", projectPath=~/git/source-project/agentmemory)`
  - `grep -rn "memory_save" src/ --include=*.ts`
  - `grep -n "agentId\|project" src/mcp/standalone.ts`
  - `grep -n "agentId" src/mcp/tools-registry.ts`
  - `grep -rn "agentmemory/remember\|mem::remember" src/ test/`
- **输出摘要**:
  - `memory_save` 在 `src/mcp/standalone.ts` 出现 **3 次**(116 validate / 175 handleProxy / 245 handleLocal),不是派单说的 1 次;`grep agentId|project src/mcp/standalone.ts` **零命中**(全文件无此概念)。
  - codegraph blast radius:`validate`/`handleProxy`/`handleLocal`/`handleProxyGeneric` 各只有 1 个调用方,全部来自同文件 `handleToolCall`(standalone.ts:355);`handleToolCall` 被 `test/mcp-standalone-proxy.test.ts`、`test/mcp-standalone.test.ts` 覆盖。
  - `tools-registry.ts:55-87` `memory_save` inputSchema properties = `content/type/concepts/files/project`,**无 `agentId`**;同文件 424/440/452/515 行其它工具的 schema 已有 `agentId`。
  - `/agentmemory/remember` 全仓仅 2 处引用:`api.ts:1039`(注册)、`standalone.ts:176`(proxy 调用),无第三方复用。
  - `grep -rn 'function_id: *"mem::remember"' src/` → **全仓仅 2 处命中**:`src/mcp/server.ts:190`(补丁 3)、`src/triggers/api.ts:1022`(补丁 4)。不存在隐藏的第三个写入者。
  - `grep -rn 'registerFunction("' src/ --include=*.ts | grep -i 'remember\|memor'` → 除 `mem::remember`(下游本体)与 `api::remember`(补丁 4)外,只有只读的 `api::memories` / `api::memory-by-id`。
  - **查法说明**:`api.ts` 端点是 `sdk.registerFunction("api::xxx", …)` 字符串键 + 匿名函数,codegraph 索引不到(`~/research/agentmemory/README.md` §6 已记的项目已知边界)。补丁 4 的 blast-radius **全程用 grep 完成,未依赖 codegraph 返回值**;§5a/§5b 涉及的普通符号才用 codegraph_explore。
- **结论**:**命题证伪**。白名单/转发逻辑本身**没有被其它端点或工具复用**(这一半是对的),但必改清单漏了 3 处:
  - **5a(硬性)** `standalone.ts:96-108 interface Validated` + `175-186 handleProxy` —— `handleProxy` 是**重建 body** 而非透传 `Validated`,只补 116-126 的白名单**完全无效**,补丁 2 实为"三处同改"。
  - **5b(硬性)** `tools-registry.ts:55-87` memory_save schema 缺 `agentId` —— 不补则 MCP 客户端无合法参数可传,补丁 3 的 `args.agentId` 恒为 undefined,整条链路仍不通。
  - **5c(软性)** `standalone.ts:245-264 handleLocal` 本地 fallback 写库不带 scope —— 仅服务不可达时生效,可判为可选。
  - 同时确认**不是**遗漏点:`handleProxyGeneric`(不裁剪参数)、`hooks/post-tool-use`(走 observe 不走 remember)、`remember.ts`(本已支持 agentId/project)。
- **日期**:2026-08-14

### F2 | 三条写入路径的端到端用例**可在现有 vitest 基础设施直接扩展**,不需起真实服务、不需改测试骨架

- **待验命题**:三条写入路径的端到端用例能在现有 vitest + mock 基础设施下直接扩展。
- **命令**:
  - `sed -n '1,80p' test/mcp-standalone-proxy.test.ts`;`sed -n '1,60p' test/mcp-standalone.test.ts`
  - `sed -n '1,70p' test/mcp-resources.test.ts`;`sed -n '1,70p' test/memories-pagination.test.ts`
  - `sed -n '1,55p' test/agent-isolation-search.test.ts`;`sed -n '1,60p' test/agent-id-scope.test.ts`
  - `grep -rln "registerMcpEndpoints\|registerApiTriggers" test/`;`ls vitest.config*`;`python3 -c "json.load(open('package.json'))..."`
- **输出摘要**:
  - `mcp-standalone-proxy.test.ts`:mock 边界**只到 `globalThis.fetch`**(`installFetch()` 第 8-14 行)+ `resetHandleForTests()`,`validate()`/`handleProxy()` 均为真实代码,现有用例已在断言 POST body 字段(`#507` 那条)。**补丁 2 的用例可直接照抄一条。**
  - `mcp-standalone.test.ts`:mock 了 `node:fs`/`logger`/`transport`/`config`,并用 `instantLocalFallbackProbe`(第 40-45 行)把 livez 探针钉死 ok:false + `fetchTrap` 拦真实 fetch → **强制走 handleLocal,永远进不了 handleProxy**。在此文件加断言**测不出补丁 2**。
  - `mcp-resources.test.ts` 第 10-66 行提供现成 `mockKV()`+`mockSdk()`+`makeReq()`,`import { registerMcpEndpoints }` 调真实注册函数,`mockSdk.overrideTrigger(id, handler)` 可拦 `mem::remember` 断言 payload → **补丁 3 直接复用**。
  - `registerApiTriggers(sdk, kv, secret?, metricsStore?, provider?)`(api.ts:138)后三参可选,同一套 mock 可驱动 → **补丁 4 复用同骨架**。但现有 3 个 import `triggers/api` 的测试(`memories-pagination`/`session-end-triggers-graph`/`consistency`)是 `readFileSync`+正则匹配**源码文本**的断言,不是行为测试,不可作参照。
  - `agent-id-scope.test.ts` 测的是 `mem::remember` 本体(本来就正常);`agent-isolation-search.test.ts` mock 掉 `src/config.js` 并直接种 `KV.observations` 测 `mem::search`。**两者都绕开全部写入路径,不能作为本次验收依据。**
  - 无 `vitest.config.*`、package.json 无 vitest 配置块,走默认配置;devDep `vitest ^4.1.6`;`npm test = vitest run --exclude test/integration.test.ts`。
- **结论**:**命题成立**。三条路径均可在现有骨架下加行为用例;唯一硬约束是**补丁 2 的用例必须放进 `mcp-standalone-proxy.test.ts` 这类 fetch-level mock 文件**,放进 `mcp-standalone.test.ts` 会因强制 local fallback 而空测(这是本条最容易踩的坑)。
- **日期**:2026-08-14

### F3 | `dist/` 当前不存在;`dist/cli.mjs` 由 tsdown `src/cli.ts` entry 产出

- **待验命题**:仓库从未构建过,`npm run build` 产出 `dist/cli.mjs`。
- **命令**:`ls -la dist/`;`cat tsdown.config.ts`;`python3 -c "json.load(open('package.json'))"` 取 scripts/bin
- **输出摘要**:`ls: 无法访问 'dist/': 没有那个文件或目录`。`package.json` `bin.agentmemory = "dist/cli.mjs"`,version 0.9.28。tsdown 五组 entry:`src/index.ts`(clean:true)、`src/cli.ts`、`src/mcp/standalone.ts` 三者 outDir=`dist`,format esm → 产出 `dist/cli.mjs` 与 `dist/standalone.mjs`;14 个 hook entry 出到 `dist/hooks/` 与 `plugin/scripts/`。`deps.neverBundle` = `@huggingface/transformers`、`@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk`。
- **结论**:**命题成立**(dist 确不存在,现场已复核)。附带结论:因 `neverBundle`,`dist/cli.mjs` 运行时依赖同工作树 `node_modules/`,D10 之后**不可删除该工作树的 node_modules**。
- **日期**:2026-08-14

### F4 | systemd 当前 ExecStart 指向 nvm 全局包;`ExecStopPost` 是派单未提及的第二处必改

- **待验命题**:D10 只需改 `ExecStart`。
- **命令**:`cat ~/.config/systemd/user/agentmemory.service`;`systemctl --user is-active agentmemory`;`systemctl --user show agentmemory -p ExecStart -p WorkingDirectory -p Environment`;`grep -n "__dirname\|import.meta.url\|iii-config" src/cli.ts`
- **输出摘要**:
  - 服务 `active`,pid 1783622,启动于 2026-08-14 10:51:21。
  - `WorkingDirectory=%h/.agentmemory`;`ExecStart=%h/.local/bin/node %h/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs --verbose`;**`ExecStopPost=-%h/.local/bin/node <同一路径> stop --force`**。
  - `src/cli.ts:70` `__dirname = dirname(fileURLToPath(import.meta.url))`;iii-config 查找顺序 `cwd/iii-config.yaml` → `__dirname/iii-config.yaml` → `__dirname/../iii-config.yaml`(409-412 行),docker-compose / .env.example 同款三段兜底。systemd 已用 `AGENTMEMORY_III_CONFIG` 显式指定,优先级更高。
  - `~/.config/agentmemory/service.env` 键:`AGENTMEMORY_SECRET`、`AGENTMEMORY_IMAGE_EMBEDDINGS`、`AGENTMEMORY_REFLECT` —— **无 `AGENT_ID`**。
- **结论**:**命题不完整**。`ExecStopPost` 与 `ExecStart` 指向同一路径,只改 ExecStart 会造成"新码启动、旧码停止"的混搭,**两行必须同改**。`WorkingDirectory` 建议保持 `%h/.agentmemory` 不动。另:服务端无 `AGENT_ID` 环境变量,`remember.ts:105` 的 `getAgentId()` 兜底恒为 undefined —— 补丁生效后 agentId 只能由请求体提供,不会被服务端环境意外污染。
- **日期**:2026-08-14

### F5 | 上游 v0.9.29 与四处补丁**零重叠**,未修复本 bug

- **待验命题**:落后的 2 个上游提交是否影响补丁基线选择。
- **命令**:`git log --oneline origin/main..HEAD`;`git log --oneline HEAD..origin/main`;`git diff --stat HEAD origin/main -- <六个关键文件>`;`git diff HEAD origin/main -- src/triggers/api.ts`;`git show origin/main:test/project-scope-parity.test.ts`
- **输出摘要**:
  - 领先 1:`acb7772`(仅 ledger.md,无 src 改动)。落后 2:`9c82d2a` v0.9.29 project-scope parity、`2973e4e` 删安全公告草稿。
  - `git diff --stat HEAD origin/main` 对 `src/state/memory-utils.ts`、`src/mcp/standalone.ts`、`src/mcp/server.ts`、`src/mcp/tools-registry.ts`、`src/functions/remember.ts` **全部空输出(零改动)**。
  - `src/triggers/api.ts` 有 11 插 1 删,全部落在 `api::mesh-export`(2767 行附近:memories 按 project 过滤 + `checkPayloadFrameSize` 返回 413),与 994 行的 `api::remember` **不相交**。
  - v0.9.29 实质是让 replay / filesystem-watcher / opencode-capture 三个采集面按同规则推导 `project`,加 `src/state/frame-guard.ts` 与 `src/cli.ts` second-instance guard;新增 4 个测试文件。
  - `npm view @agentmemory/mcp version` / `npm view @agentmemory/agentmemory version` 均为 **0.9.28**(0.9.29 尚未发布到 registry)。
- **结论**:**上游没有修本 bug**,补丁在两个基线上都必要,且冲突风险都极低。真正的差异在归因难度:同步 origin/main 会把 second-instance guard / frame-guard / cli 未知命令拒绝等无关行为变更一并带进 D10 重启;基于当前 HEAD 则 D10 只变"作用域补丁"一个变量。判断依据已写入 codebase-survey.md §5 对照表,**不代用户做决定**。
- **日期**:2026-08-14

### F6 | npx 缓存新鲜度机制(源码级),及"不锁版本 vs 锁版本"的行为差异

> 本条是 F7(未能核验)的机制性支撑,单独列出因为机制本身已在本机 npm 源码上核实到位。

- **待验命题**:npx 判定本地包缓存新鲜度的机制是什么;`_npx.packages` 锁定与不锁定版本号的行为差异。
- **命令**:
  - `npm --version` → 11.16.0;`node --version` → v24.18.0
  - `sed -n '22,90p;236,319p' $(npm root -g)/npm/node_modules/libnpmexec/lib/index.js`(npm 自带 `libnpmexec`,319 行)
  - `cd $(npm root -g)/npm && node -e "npa('@agentmemory/mcp') …"` 验证 spec 解析
  - `python3` 读 `~/.npm/_npx/ba4b5775a0ab44e2/package-lock.json` 取 `resolved`
- **输出摘要**:
  - **缓存目录名 = sha512(排序后的 packages 字符串).slice(0,16)**(index.js:242-254)。`@agentmemory/mcp` 与 `@agentmemory/mcp@0.9.28` 是不同字符串 → 必然落在两个不同哈希目录,这解释了本机 `ba4b5775a0ab44e2` / `895ddc906593189f` 并存。
  - `npa("@agentmemory/mcp")` → `{type:"range", rawSpec:"*", registry:true}`,且 `spec.name === spec.raw` → `npxByNameOnly = true`。
    `missingFromTree` 的守卫 `if (spec.registry && spec.type !== 'tag' && !npxByNameOnly)` 因此为 **false** → 走 else 分支 → **无条件调用 `getManifest()`,而 `getManifest` 硬编码 `pacote.manifest(spec, {..., preferOnline: true})`**(index.js:26-37)。`preferOnline:true` 写在 `...flatOptions` 之后,**用户的 `--prefer-offline` 覆盖不掉**。
    → **不锁版本时:每次 `npx -y @agentmemory/mcp` 都会联网向 registry 拉 manifest。**
  - 新鲜度比较依据是 **`node.package.resolved === manifest._resolved`**(即 tarball URL),index.js:78-83。**不是文件内容 hash、不是 mtime**。本机 `~/.npm/_npx/ba4b5775a0ab44e2/package-lock.json` 记录 `resolved = https://registry.npmjs.org/@agentmemory/mcp/-/mcp-0.9.28.tgz`。
  - `npa("@agentmemory/mcp@0.9.28")` → `{type:"version", rawSpec:"0.9.28"}`,`npxByNameOnly=false` → 走**第一个分支**,命中 `spec.type === 'version' && node.pkgid === spec.raw` 即 `return {node}`,**全程不发起 manifest 请求**。
    → **锁版本时:纯离线命中,永不联网、永不 reify。**
  - 只有 `add.length > 0` 时才 `npxArb.reify({save:true, add})` 重装(index.js:307-313)。
- **结论(证据等级:[源码],npm 11.16.0 自带 libnpmexec)**:
  1. 手工覆盖 `~/.npm/_npx/ba4b5775a0ab44e2/node_modules/@agentmemory/agentmemory/dist/standalone.mjs` **不会**改变 `package-lock.json` 里的 `resolved`,因此 **只要 registry 上 `@agentmemory/mcp` 的 latest 仍解析到 0.9.28 的同一个 tarball URL,后续 `npx -y @agentmemory/mcp` 就命中缓存、不 reify,手工补丁保留**。
  2. **一旦 `@agentmemory/mcp` 发布新版本(如 0.9.29),`manifest._resolved` 变化 → 触发 reify → 手工补丁被静默冲掉,且无任何提示。** 当前 registry latest = 0.9.28,而本仓 origin/main 已有 v0.9.29 release commit,**发布随时可能发生,这是补丁 2 手工覆盖方案的真实衰减风险**。
  3. 另一条隐性风险:`@agentmemory/agentmemory` 是 `@agentmemory/mcp` 的**传递依赖**(`~0.9.0`),npx 的新鲜度检查**只查顶层 `packages`**。所以 `@agentmemory/agentmemory` 单独发新版**不会**触发重装 —— 这个方向反而是安全的。
  4. **路径纠正(重要)**:待覆盖的文件不在 `@agentmemory/mcp` 包内。`ls ~/.npm/_npx/ba4b5775a0ab44e2/node_modules/@agentmemory/mcp/` 只有 `bin.mjs`(418 B)/`LICENSE`/`package.json`/`README.md`;`bin.mjs` 内容是 `import("@agentmemory/agentmemory/dist/standalone.mjs")`。真实目标是 `~/.npm/_npx/ba4b5775a0ab44e2/node_modules/@agentmemory/agentmemory/dist/standalone.mjs`(49690 B,mtime 2026-07-30 14:13)。intake/PM 取证把它记成"`ba4b5775a0ab44e2` 下 `dist/standalone.mjs`"——目录层级需按此更正,否则 s2/s3 会覆盖错文件。
  5. 目录 mtime 补充:`ba4b5775a0ab44e2` 目录本身 mtime 是 2026-08-14 11:10,但其 `package.json` / `package-lock.json` / `node_modules` 全部是 **2026-07-30 14:13**,即树是 7 月 30 日装的,不是 8 月 14 日新建。intake"2026-08-14 建"的描述需更正。
- **日期**:2026-08-14

---

## 未能核验

### U1 | 手工覆盖 npx 缓存后补丁是否持续生效 —— 未做本机真实覆盖测试,原因是风险

- **命题**:手工覆盖 npx 缓存目录下的 `standalone.mjs` 后,补丁会持续生效,不会被后续 `npx -y @agentmemory/mcp` 调用静默重装覆盖回原版本。
- **未能核验原因**:**未做本机真实覆盖测试,原因是风险**——`plugin/.mcp.json` 的 `npx -y @agentmemory/mcp` 正是本会话自己在用的 agentmemory MCP server 的启动方式,覆盖该文件并触发重连会直接影响当前会话的 MCP 工具可用性,派单亦明确禁止。因此本条只做了源码级机制调研,未取得端到端实测证据。
- **机制性调研结论(补充说明,证据等级 [源码],详见上文 F6)**:
  - npx 的缓存新鲜度判定依据是 **`package-lock.json` 里记录的 tarball `resolved` URL 与 registry manifest `_resolved` 是否相等**(npm 11.16.0 `libnpmexec/lib/index.js:78-83`),**与被覆盖文件的内容、mtime 无关**。
  - `@agentmemory/mcp` 这种**不带版本号**的 spec 会命中 `npxByNameOnly` 路径,**每次都用 `preferOnline:true` 联网拉 manifest**(index.js:26-37),且该标志写在 `...flatOptions` 之后,用户侧 `--prefer-offline` 无法覆盖。
  - 因此:**registry latest 保持 0.9.28 期间,手工覆盖能存活;`@agentmemory/mcp` 一发新版就会被 reify 静默冲掉。** 当前 registry latest 实测为 0.9.28,而 origin/main 已存在 v0.9.29 release commit —— **衰减是"何时发生"而非"是否发生"的问题。**
  - 对照:`895ddc906593189f`(`_npx.packages = ["@agentmemory/mcp@0.9.28"]`,锁版本)走纯离线分支,永不联网、永不 reify;但它不是 `plugin/.mcp.json` 当前参数解析到的目录,不能靠它规避。
  - 由此派生一条本次未被列入的**方案面待拍板项**:若要让补丁 2 在 MCP stdio 路径上**稳定**生效,手工覆盖 npx 缓存不是可靠机制(上界是"下一次 @agentmemory/mcp 发版")。更可逆的替代是把 `.mcp.json` 的 `command/args` 指向工作树构建产物 `node .../dist/standalone.mjs`(与 D10 对 systemd 的做法同构,回滚即改回 npx)。**此项属方案设计,本次只提出,不做判断。**
- **另需注意**:若最终仍选手工覆盖,必须**先备份**原始 `~/.npm/_npx/ba4b5775a0ab44e2/node_modules/@agentmemory/agentmemory/dist/standalone.mjs`(49690 B),否则 intake Q7 的"回滚只改 ExecStart"不成立 —— MCP 侧会残留改动过的代码。

### U2 | `dist/cli.mjs` 实际能否拉起 worker、行为与全局包一致 —— 未做构建与拉起

- **命题**:把 `ExecStart` 指向工作树构建产物可正常拉起 worker,运行行为与当前全局包一致。
- **未能核验原因**:本次派单为"只读探查,不改代码",`npm run build` 会创建 `dist/`(写操作,且 `src/index.ts` 那组 entry 带 `clean:true`),拉起验证还需 `systemctl restart` 影响在用服务,均超出本次授权范围。
- **已取得的静态判断依据(证据等级 [源码],非实测)**:`src/cli.ts:70` 用 `import.meta.url` 推导 `__dirname`,iii-config / docker-compose / .env.example 三处路径解析均为 `cwd → __dirname → __dirname/..` 三段兜底(cli.ts:409-412、666-668、2180-2182);build 脚本会把 `iii-config.yaml` 拷进 `dist/`,工作树根另有一份,两条兜底都成立;且 systemd 已用 `AGENTMEMORY_III_CONFIG` 显式指定,优先级最高。**静态看不出阻塞项,但未经实际构建+拉起证实。**

### U3 | D10 那次 `systemctl restart` 的中断时长 —— 未实测

- **命题**:D10 切换的服务中断时长在可接受范围内。
- **未能核验原因**:测量需真实重启在用服务,超出本次只读授权;且用户已在 Q6 批复"直接执行不特别处理",该命题对本次决策不再是阻塞项。已知参照:`evidence/scope-isolation.sh`(位于 `/home/ky/research/agentmemory/evidence/`,**不在本仓库内**)里的 120 秒等待窗口是**索引重建**耗时,不等于冷启动耗时,不可直接引用。
