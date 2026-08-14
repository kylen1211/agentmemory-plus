# codebase-survey — memory-scope-isolation(s1a 代码盘点,只读)

盘点日期:2026-08-14 / 仓库 HEAD:`acb7772` / 分支:`main`

---

## 1. 补丁 2/3/4 blast-radius

### 1.1 补丁 2 — `src/mcp/standalone.ts`(真 MCP stdio 主路径)

**实测:全文件 `grep -n "agentId" src/mcp/standalone.ts` 零命中,`project` 同样零命中。**
也就是说这两个字段不是"被白名单裁掉一处",而是这个文件从头到尾没有该概念。

`memory_save` 在本文件出现 **三处**,不是派单说的一处:

| 行 | 位置 | 现状 | 是否必改 |
|---|---|---|---|
| 96-108 | `interface Validated` | 无 `project` / `agentId` 字段 | **必改**(不改则后两处无处承载) |
| 116-126 | `validate()` case memory_save | 只取 `content/type/concepts/files` | **必改**(白名单入口) |
| 175-186 | `handleProxy()` case memory_save | 手工重建 body,只发 `content/type/concepts/files` 到 `POST /agentmemory/remember` | **必改**(第二道丢弃点) |
| 245-264 | `handleLocal()` case memory_save | 写本地 `InMemoryKV`,不写 `agentId/project` | 见 §1.4 判断 |

> 关键:**只补 116-126 无效**。`validate()` 返回的是强类型 `Validated`,`handleProxy` 在 178-183 行是**重新构造 body 对象**而不是透传 `v`,所以 116-126 即使把 project/agentId 塞进 `v`,handleProxy 依然会把它们丢掉。三处必须同改,这是本次盘点最重要的发现。

**调用方/复用方**(codegraph blast radius):
- `validate` / `handleProxy` / `handleLocal` / `handleProxyGeneric` 均为模块私有,各自**只有 1 个调用方**,全部来自同文件的 `handleToolCall`(standalone.ts:355)。
- `handleToolCall` 是本文件唯一导出的调用入口,3 个调用方(本文件 stdio transport dispatch)+ 测试 `test/mcp-standalone-proxy.test.ts`、`test/mcp-standalone.test.ts`。
- **结论:白名单逻辑没有被任何其它端点/工具复用**,改动完全封闭在 standalone.ts 内,对外只经 `handleToolCall` 一个口子。

**旁路确认(重要):`handleProxyGeneric`(336-353)不裁剪参数**——它把 `args` 原样 POST 到 `/agentmemory/mcp/call`。但 `memory_save ∈ IMPLEMENTED_TOOLS`(16-24 行),`handleToolCall:366` 的分流决定了 memory_save **永远走裁剪路径**,拿不到这条无损通道。所以补丁 2 无法用"把 memory_save 移出 IMPLEMENTED_TOOLS"绕过(那会连本地 fallback 一起丢)。

### 1.2 补丁 3 — `src/mcp/server.ts`(REST `/agentmemory/mcp/call` 路径)

`memory_save` 分支在 **server.ts:168-198**。现状:
- 已经处理 `project`(182-185 行,trim + 空串过滤,`...(project !== undefined && { project })`);
- **完全没有 `agentId`**,`sdk.trigger("mem::remember")` 的 payload 里无该字段。

同文件内 `agentId` 的既有用法(可直接照抄的约定):
- `server.ts:116-129` `memory_recall` 分支——`#817` 已为读侧做了同样的透传,注释明确写"no agentId → falls back to env AGENT_ID";
- `server.ts:722/738/766/854` —— actions / messages 类工具直接透传 `args.agentId`。

**调用方**:整个 switch 只有一个入口 `registerMcpEndpoints` 注册的 `/agentmemory/mcp/call`(server.ts:76-85 取 `req.body.{name, arguments}`,arguments 原样进 switch,不预裁剪)。**没有第二处复用。**

### 1.3 补丁 4 — `src/triggers/api.ts` `api::remember`(REST `/agentmemory/remember`,`agent-mem` CLI 与补丁 2 的下游)

- 位置:`api.ts:994-1035`,HTTP 注册在 1036-1040(`POST /agentmemory/remember`)。
- 请求体泛型(996-1004)声明了 `content/type/concepts/files/ttlDays/sourceObservationIds/project`,**无 `agentId`**;
- 1021-1032 的 `sdk.trigger("mem::remember")` payload 逐字段展开,`agentId` 无处可进。
- 下游 `mem::remember`(`src/functions/remember.ts:23-32`)**本来就接受 `agentId`**,102-105 行 `data.agentId ?? getAgentId()`,125 行落库。所以补丁 4 纯粹是 api 层没开口子。

既有约定(照抄对象):`api.ts:585` `api::session::start` 的 605-609 行——
`typeof body.agentId === "string" && body.agentId.trim().length > 0 ? body.agentId.trim().slice(0,128) : undefined`,再 `?? getAgentId()`。**128 字符截断**与 `remember.ts:104` 完全一致,建议补丁 4 沿用同一写法(而不是自创)。

> **查法说明(工具边界)**:`api.ts` 的端点是 `sdk.registerFunction("api::xxx", async () => {})` 字符串键 + 匿名函数注册,codegraph 索引不到这类符号(`~/research/agentmemory/README.md` §6 已记的本项目已知边界)。本节 1.3 的 blast-radius **全部用 grep 字符串检索完成,未依赖 codegraph 返回值**,不存在"codegraph 返回空 → 误判无遗漏"的情况。§1.1/§1.2/§5b 三处是普通符号,codegraph_explore 正常适用。

**调用方**:`/agentmemory/remember` 在全仓只有两个引用点——`api.ts:1039`(注册)与 `standalone.ts:176`(补丁 2 的 proxy 调用)。**外部无其它复用**。

### 1.4 第五处遗漏点判定

盘点出 **3 个真实的额外位置**,派单的"四处必改清单"不完整:

| # | 位置 | 性质 | 建议 |
|---|---|---|---|
| **5a** | `src/mcp/standalone.ts:96-108` `interface Validated` + `175-186` `handleProxy` body 重建 | **硬性遗漏**,不改则补丁 2 完全无效 | 必须并入补丁 2 |
| **5b** | `src/mcp/tools-registry.ts:55-87` `memory_save` inputSchema | **硬性遗漏**,不改则 MCP 客户端根本无法声明 `agentId` 参数 | 见下 |
| 5c | `src/mcp/standalone.ts:245-264` `handleLocal` 本地 fallback 写库 | 软性,仅在服务不可达时生效 | 见下 |

**5b 详述**:`tools-registry.ts` 的 `memory_save` schema properties 只有 `content/type/concepts/files/project`,**没有 `agentId`**。这是全链路的最上游 —— server 端 `/agentmemory/mcp/tools` 与 standalone 的 fallback tools 列表都由 `getAllTools()`(tools-registry.ts:951)供给。schema 不暴露 `agentId`,即使补丁 2/3 都改对,MCP 客户端(Claude Code)也没有合法参数可传,补丁 3 的 `args.agentId` 永远是 undefined。
同文件 `agentId` 已在 424 / 440 / 452 / 515 行出现于 actions/messages 类工具的 schema,**加字段有先例、风格一致**。
`getAllTools` blast radius:13 个调用方(`src/cli.ts`、`src/index.ts`、`src/mcp/standalone.ts`、`scripts/skills/generate.ts` 等),被 4 个测试覆盖(`test/consistency.test.ts`、`test/mcp-standalone.test.ts`、`test/mcp-surface-default.test.ts`、`test/tool-count-consistency.test.ts`)——**只加 property 不加工具、不改 `required`,工具计数不变,这 4 个测试预期不受影响**(需实跑确认)。另需注意 `npm run skills:gen`/`skills:check` 由 schema 生成技能文档,改 schema 后可能需要重生成(`scripts/skills/generate.ts` 是 `getAllTools` 调用方之一)。

**5c 详述**:`handleLocal` 只在 `resolveHandle()` 判定 server 不可达时执行,写的是 `~/.agentmemory` 下的 standalone JSON,与 worker 主库不是同一份数据。本次 D10 之后 worker 常驻,该路径日常不触发。**建议:列入 design.md 但标为可选/低优先,不改也不影响主路径验收**;若不改,应在 RISKS 里书面承认"本地 fallback 写入仍不带 scope"。

**排查过的、确认不是遗漏点的**:
- `handleProxyGeneric`(standalone.ts:336)不裁剪参数,无需改;
- `src/hooks/post-tool-use.ts` / `plugin/scripts/post-tool-use.mjs` 走 `/agentmemory/observe` 写 observation,不经 `mem::remember`,不在本次范围;
- `mem::remember` 本体(`remember.ts`)已支持 `agentId`+`project`,不需要改;
- `memoryToObservation`(补丁 1)的 12 处调用点已由 README 查过,本次未重查。

**全仓写侧收口核对(grep,非 codegraph)**:
```
$ grep -rn 'function_id: *"mem::remember"' src/
src/mcp/server.ts:190       # 补丁 3
src/triggers/api.ts:1022    # 补丁 4
$ grep -rn 'registerFunction("' src/ --include=*.ts | grep -i 'remember\|memor'
src/functions/remember.ts:23   mem::remember       # 下游本体,已支持 agentId/project
src/triggers/api.ts:994        api::remember       # 补丁 4
src/triggers/api.ts:1903       api::memories       # 只读列表
src/triggers/api.ts:1987       api::memory-by-id   # 只读单条
```
**全仓只有 2 处触发 `mem::remember`,即补丁 3 与补丁 4,不存在隐藏的第三个写入者。**
注:`POST /agentmemory/import`(api.ts:1325/1344)是 `evidence/scope-isolation.sh` 走的直灌入口,绕过 `mem::remember`,这正是它只能验证补丁 1(读侧)的原因;`api::lesson-save`(3150)写的是 lessons 而非 memories,不在本次范围。

---

## 2. 现有测试的 mock 边界

### 2.1 `test/mcp-standalone-proxy.test.ts`(386 行)—— **补丁 2 的理想载体**

- mock 边界:**只替换 `globalThis.fetch`**(`installFetch()`,第 8-14 行),`resetHandleForTests()` 复位 rest-proxy 句柄;
- 直接 `import { handleToolCall } from "../src/mcp/standalone.js"` 调**真实**代码路径;
- `validate()` → `handleProxy()` → body 构造 **全部未被 mock**,断言可以直接读到 POST 出去的 JSON body(现有用例 `proxies memory_recall to POST /agentmemory/search and forwards format/token_budget (#507)` 就是这个套路,把 `init.body` 解出来断言字段)。
- **判定:补丁 2 的端到端用例可以直接照现有用例复制一条,零骨架改动。** 断言形如"POST `/agentmemory/remember` 的 body 含 `agentId` 与 `project`",改前必红、改后必绿。

### 2.2 `test/mcp-standalone.test.ts`(452 行)—— **测不出补丁 2**

- mock 面很宽:`node:fs`、`src/logger.js`、`src/mcp/transport.js`、`src/config.js` 全 mock;
- 关键是第 40-50 行用 `instantLocalFallbackProbe` 把 livez 探针**钉死为 ok:false**,并装了 `fetchTrap` 让任何真实 fetch 抛错 —— 即本文件**强制走 `handleLocal` 本地分支,永远进不了 `handleProxy`**。
- **判定:在这个文件里加断言只能覆盖 5c(handleLocal),覆盖不到补丁 2 的代理路径。补丁 2 的用例不要往这里放。**

### 2.3 `test/agent-id-scope.test.ts`(269 行)—— 与本次补丁无关

- 前半段测 `loadAgentScope/getAgentId` 读 `AGENT_ID` 环境变量;
- 后半段(46 行起)`describe("mem::remember stamps agentId on the Memory (#554)")` 用自建 `mockKV()` 直接 `sdk.trigger("mem::remember", …)`;
- 测的是**下游本来就正常的函数**,四处补丁一处都不经过。**不能作为验收依据。**

### 2.4 `test/agent-isolation-search.test.ts`(203 行)—— 读侧,与写侧补丁无关

- mock 掉 `src/config.js`(`getAgentId`/`isAgentScopeIsolated` 换成可控 `configState`)、`keyed-mutex`、`audit`、`access-tracker`;
- 直接往 mockKV 的 `KV.observations` 种数据后调 `mem::search`。**完全绕开所有写入路径。**

### 2.5 补丁 3 / 补丁 4 的可用骨架

- **补丁 3(server.ts)**:`test/mcp-resources.test.ts` 第 10-66 行已有现成的 `mockKV()` + `mockSdk()` + `makeReq()` 三件套,`import { registerMcpEndpoints } from "../src/mcp/server.js"` 调真实注册函数。`mockSdk` 带 **`overrideTrigger(id, handler)`**,可以拦住 `mem::remember` 并断言收到的 payload —— 这正是补丁 3 需要的断言点,且 memory_save switch 分支本身不被 mock。**可直接复用,不需要起真实服务。**
- **补丁 4(api.ts)**:`registerApiTriggers(sdk, kv, secret?, metricsStore?, provider?)`(api.ts:138),签名后三个参数可选,可用同一套 `mockSdk/mockKV/makeReq` 驱动 → 取 `sdk.getFunction("api::remember")` 直接调,再用 `overrideTrigger("mem::remember")` 断言 payload 含 `agentId`。
  ⚠️ 注意:现有三个 import `triggers/api` 的测试(`memories-pagination.test.ts`、`session-end-triggers-graph.test.ts`、`consistency.test.ts`)其实是 **`readFileSync` + 正则匹配源码文本** 的"断言源码长什么样"式测试,**不是行为测试**,不能作为骨架参照,也不建议照抄这种写法(它测不出运行时行为)。补丁 4 应新建行为用例,骨架从 `mcp-resources.test.ts` 借。

### 2.6 测试基础设施结论

- 无 `vitest.config.*`,package.json 也无 `vitest` 配置块,走 vitest 默认(devDep `vitest ^4.1.6`),`npm test` = `vitest run --exclude test/integration.test.ts`;
- 三条写入路径的端到端用例 **全部可以在现有 vitest + 现有 mock 套路下扩展**,不需要起真实服务、不需要改测试骨架;
- 唯一约束:补丁 2 的用例必须放在 `mcp-standalone-proxy.test.ts` 风格(fetch-level mock),放进 `mcp-standalone.test.ts` 会因强制 local fallback 而空测。

---

## 3. build 脚本与 `dist/` 产出

- `package.json`:`name=@agentmemory/agentmemory`,`version=0.9.28`,`type=module`,`bin.agentmemory = "dist/cli.mjs"`。
- `build` 脚本:`tsdown && cp iii-config.yaml dist/ && cp iii-config.docker.yaml dist/ && cp docker-compose.yml dist/ && cp .env.example dist/ && mkdir -p dist/viewer && cp src/viewer/index.html dist/viewer/ && cp src/viewer/favicon.svg dist/viewer/`(前四个 cp 带 `|| true` 容错,后两个不容错)。
- `tsdown.config.ts` 五组 entry:
  - `src/index.ts` → `dist/`(dts + sourcemap + **`clean: true`**,带 `#!/usr/bin/env node` banner)
  - `src/cli.ts` → `dist/` → 产出 **`dist/cli.mjs`**(format esm,target node20,`clean:false`)
  - `src/mcp/standalone.ts` → `dist/` → 产出 **`dist/standalone.mjs`**(即补丁 2 的运行时载体)
  - 14 个 hook entry → `dist/hooks/` 与 `plugin/scripts/`
  - `deps.neverBundle`: `@huggingface/transformers`、`@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk` —— 这三个保持 node_modules 外部引用,**意味着 `dist/cli.mjs` 运行时依赖同工作树的 `node_modules/`,不能单独把 dist/ 拷到别处跑**。
- **现场复核:`ls dist/` → `ls: 无法访问 'dist/': 没有那个文件或目录`。确认仓库从未构建过。**
- 路径解析(与 D10 相关,`src/cli.ts:70` `const __dirname = dirname(fileURLToPath(import.meta.url))`):
  - iii-config 查找顺序(409-412):`process.cwd()/iii-config.yaml` → `__dirname/iii-config.yaml` → `__dirname/../iii-config.yaml`;
  - docker-compose(666-668、1027-1029)、.env.example(2180-2182)同款三段查找。
  - 含义:`__dirname` = `<worktree>/dist`,而 build 脚本已把 `iii-config.yaml` 拷进 `dist/`,同时 `__dirname/..` = 工作树根也有一份 —— **两条兜底都成立**,`WorkingDirectory` 保持 `%h/.agentmemory` 不会破坏解析(且 systemd 已用 `AGENTMEMORY_III_CONFIG` 显式指定配置路径,优先级更高)。这是静态代码判断,**未做实际构建+拉起验证**。

---

## 4. systemd `ExecStart` 改法建议(只给建议,未改文件)

当前 `~/.config/systemd/user/agentmemory.service`(实测 `systemctl --user is-active agentmemory` = `active`,pid 1783622,启动于 2026-08-14 10:51):

```ini
WorkingDirectory=%h/.agentmemory
ExecStart=%h/.local/bin/node %h/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs --verbose
ExecStopPost=-%h/.local/bin/node %h/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs stop --force
```

建议改法(最小改动,只换两行的脚本绝对路径):

```ini
WorkingDirectory=%h/.agentmemory
ExecStart=%h/.local/bin/node %h/git/source-project/agentmemory/dist/cli.mjs --verbose
ExecStopPost=-%h/.local/bin/node %h/git/source-project/agentmemory/dist/cli.mjs stop --force
```

要点:
1. **`ExecStopPost` 必须同改**。只改 `ExecStart` 会出现"新代码启动、旧全局包代码停止"的混搭,停机路径行为不一致。派单只提了 ExecStart,这里补一条。
2. `WorkingDirectory` **建议保持 `%h/.agentmemory` 不动**:数据目录与 pid/state 文件都在那里,改成工作树会让 `process.cwd()` 优先命中仓库根的 `iii-config.yaml`(与 `AGENTMEMORY_III_CONFIG` 指向的 `%h/.agentmemory/iii-config.yaml` 不是同一份),平添差异。
3. `%h` 展开为 `/home/ky`,所以绝对路径可写死 `/home/ky/git/source-project/agentmemory/dist/cli.mjs`,也可用 `%h/git/...`;后者更符合本 unit 现有风格。
4. **前置条件**:`dist/` 必须先 `npm run build` 产出;且因 `deps.neverBundle`,工作树的 `node_modules/` 必须完整保留(现已存在,214 项)。**不要在 D10 之后对该工作树做 `rm -rf node_modules`。**
5. 生效需 `systemctl --user daemon-reload && systemctl --user restart agentmemory`。
6. 回滚:把两行路径改回 `%h/.nvm/versions/node/v24.18.0/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs` + daemon-reload + restart,无其它状态需要还原(全局包目录本次不动)。
7. **副作用提示**:origin/main 的 `src/cli.ts` 新增了"second-instance guard"(启动前探 `/agentmemory/livez`,已在跑就 `exit 1`)。若后续同步了 origin/main 再构建,重启顺序必须是 stop→start(systemd `restart` 本身满足),但手工并行拉起会被这个 guard 拒绝——记一笔,别当成故障。

`~/.config/agentmemory/service.env` 现有三个键:`AGENTMEMORY_SECRET`、`AGENTMEMORY_IMAGE_EMBEDDINGS`、`AGENTMEMORY_REFLECT`。**没有 `AGENT_ID`**,所以 `remember.ts:105` 的 `getAgentId()` 兜底返回 `undefined` —— 这解释了为什么当前所有 memory 都是无 agentId 的裸记录,也说明补丁生效后 agentId 只能靠请求体传入,不会被服务端环境变量意外污染。

---

## 5. 当前分支状态与"直接开分支 vs 先同步 origin/main"的判断依据

```
$ git rev-parse --abbrev-ref HEAD   → main
$ git log --oneline -1              → acb7772 pipeline(memory-scope-isolation): s0 done
$ git log --oneline origin/main..HEAD
acb7772 pipeline(memory-scope-isolation): s0 done          # 领先 1

$ git log --oneline HEAD..origin/main
2973e4e chore: remove drafts (#1170)                       # 落后 2
9c82d2a chore(release): v0.9.29 with project-scope parity across capture surfaces (#1141)

$ git status --short
 M pipeline/memory-scope-isolation/ledger.md
 M plugin/scripts/antigravity-bridge.mjs                   # 非本次任务改动
?? .gitattributes
?? SCHEDULING-AND-EVICTION-NOTES.md
?? pipeline/memory-scope-isolation/research/
```

**领先的 1 个提交**:`acb7772`,内容仅 `pipeline/memory-scope-isolation/ledger.md`(37 行),是本次 pipeline 自身产物,不含任何 src 改动。

**落后的 2 个提交**:
- `9c82d2a` v0.9.29 —— 标题虽是 "project-scope parity",但**实测与四处补丁不冲突**:
  ```
  $ git diff --stat HEAD origin/main -- src/state/memory-utils.ts src/mcp/standalone.ts src/mcp/server.ts src/mcp/tools-registry.ts src/functions/remember.ts
  (空输出 — 五个文件全部零改动)
  $ git diff --stat HEAD origin/main -- src/triggers/api.ts
  src/triggers/api.ts | 12 +++++++++++-  (11 插入 1 删除)
  ```
  api.ts 的这 11 行落在 **`api::mesh-export`**(2767 行附近:memories 按 project 过滤 + `checkPayloadFrameSize` 返回 413),与 `api::remember`(994 行)**物理与语义都不相交**。
  它的实质内容是让 replay/filesystem-watcher/opencode-capture 三个采集面按同一规则推导 `project`,外加 `src/state/frame-guard.ts` 新文件与 `src/cli.ts` 的 second-instance guard。
- `2973e4e` 删 `.github/security-advisories/*` 草稿,纯文档。

**判断依据(供拍板,不代做决定)**:

| 维度 | 基于当前 HEAD 直接开分支 | 先同步 origin/main 再开 |
|---|---|---|
| 冲突风险 | 四处补丁的目标文件与上游改动**零重叠**,rebase/merge 冲突概率极低 | 同左 |
| 补丁有效性 | 上游**没有修**本 bug(五个关键文件零 diff),补丁在两个基线上都必要 | 同左 |
| 版本一致性 | 构建出的 `dist/cli.mjs` 是 0.9.28,与当前全局包版本一致,D10 前后"只换了作用域补丁"这一个变量 | 变成 0.9.29,D10 同时引入 second-instance guard、frame-guard、cli 未知命令拒绝等**与本次无关的行为变更**;若重启异常,归因困难 |
| 测试基线 | 不引入上游新测试文件,`npm test` 基线就是当前工作树跑出来的那个 | 多出 `frame-guard.test.ts`、`project-scope-parity.test.ts`、`mesh-export-project-scope.test.ts`、`cli-second-instance-guard.test.ts` 4 个新文件;`project-scope-parity.test.ts` 会 `git init` 临时仓库并执行 `execFileSync`,是否在本机稳定跑通未验证 |
| 后续合并成本 | 落后 2 个提交,后面补合的成本 = 现在同步的成本,不增不减 | 一次付清 |

倾向性事实(不是决定):**从"隔离变量、便于归因"角度,基于当前 HEAD 直接开分支的技术风险更低**;从"贴近上游、少一次 rebase"角度则相反。两者的冲突风险差异可忽略,真正的差异在 D10 重启时的**归因难度**。

**改动边界的两个卫生问题**(建议 s2 之前处理,不属技术判断):
1. ⚠️ 盘点开始时(12:00 左右)`plugin/scripts/antigravity-bridge.mjs` 处于 modified 状态,origin/main 对该文件的 diff stat 却是 0 行变化(疑似权限/换行属性差异,与未跟踪的 `.gitattributes` 有关);**盘点结束时(12:14)复查 `git status --short` 该条已消失**——工作树在本次只读盘点期间被并行任务动过(同目录同时出现了 `research/build-spike.md`)。此状态**易变、不可当作稳定事实**,开分支前请以当时的 `git status` 现场为准重新确认。
2. `.gitattributes`、`SCHEDULING-AND-EVICTION-NOTES.md` 两个未跟踪文件与本次无关(盘点前后均在),建议 stash 或先不 `git add -A`。
3. ledger `base_commit: d60652a7...` 与当前 HEAD `acb7772` 不一致(base_commit 记录于 ledger commit 之前)。若后续用 base_commit 做 diff 基线,注意这一条。
