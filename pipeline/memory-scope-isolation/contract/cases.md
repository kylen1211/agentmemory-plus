# contract/cases.md — memory-scope-isolation 可执行验收用例清单(档位 cases)

> 冻结属性:本文件在 s2b 一次呈批时与 design.md、tasks/ 一并冻结;`gen-contract.sh` 由本文件的 yaml 块确定性生成 `generated/cases/*.sh`,gate integrate 直接跑。
> 用例即判据:实现节点不得改本文件,只能让用例变绿;认为用例本身错 → 走 RISKS 回派,不自行改。

## 执行环境约定(全部用例共用)

- **工作目录**:`generated/run-cases.sh` 由 `gate.sh` 在**主工作树根**(`/home/ky/git/source-project/agentmemory`)下执行,用例内相对路径以此为准。
- **单机部署假设**:FR-6/FR-7 的用例涉及本机 systemd user 服务与本机 worker(`http://localhost:3111`),路径按本机绝对路径写死(该两条 FR 的验收对象本身就是本机环境,不具备跨机可移植性)。
- **鉴权**:live 类用例优先取环境变量 `AGENTMEMORY_SECRET`;未设置时从 `~/.config/agentmemory/service.env` 读取。用例内不出现任何真实密钥。
- **测试命名硬约定**:FR-1~FR-5 的新增/改动 vitest 用例,其标题(describe + it 拼接后的全名)**必须以 `FR-N ` 开头**(N 为需求号,后跟一个空格),否则 `-t` 过滤取不到 → 用例判红。
- **零匹配即判红(实测依据)**:`npx vitest run <file> -t <不存在的名字>` 实测 **exit 0**(输出 `Tests 16 skipped (16)`)。因此每条 vitest 用例的判据不是"退出码 0"单独成立,而是**退出码 0 且输出出现 `Tests <n> passed`**,n 的下限由 `expect_out` 正则钉死。这是本清单防"空测假绿"(坑库 P19)的核心机制。
- **改前必红属性**:每条用例的 `red_anchor` 字段记录该用例在补丁前的实际表现;live 类三条已在 s2a 现场实跑取得红证据(见 design.md 现状盘点 preflight 块)。

---

## FR-1 | `memoryToObservation()` 透传 agentId + project

用例落点:**新建** `test/memory-scope-isolation.test.ts`(理由见 design.md ADR-3)。至少两条:①透传;②两字段均 `undefined` 时输出同为 `undefined` 且不抛错。

```yaml
cases:
  - id: C-FR1-1
    fr: FR-1
    owner: backend-dev
    desc: memoryToObservation 透传 agentId/project 且 undefined 边界不误填
    red_anchor: 补丁前该文件不存在,vitest 报 No test files found 并 exit 1
    cmd: |-
      npx vitest run test/memory-scope-isolation.test.ts -t "FR-1 "
    expect_exit: 0
    expect_out: "Tests +([2-9]|[1-9][0-9]+) passed"
```

## FR-2 | `standalone.ts` 三处同改(Validated / validate / handleProxy)

用例落点:**`test/mcp-standalone-proxy.test.ts`(硬性约束,已写进命令本身)**。该文件 mock 边界只到 `globalThis.fetch`,`validate`/`handleProxy` 走真实代码;放进 `test/mcp-standalone.test.ts` 会被 `instantLocalFallbackProbe` 强制走 `handleLocal`,断言永远碰不到代理分支(facts.md F2)。本条 cmd 只跑 proxy 文件,放错文件 = 该文件内零匹配 = 输出只有 skipped = `expect_out` 不满足 = 判红,不依赖人工复核。
至少两条:①带 `agentId`/`project` 时 mock fetch 捕获的 POST body 含该两字段;②两字段未传时 body 中不出现或为 `undefined`。

```yaml
cases:
  - id: C-FR2-1
    fr: FR-2
    owner: backend-dev
    desc: MCP stdio 代理路径把 agentId/project 带进发往 /agentmemory/remember 的 body,未传时不污染
    red_anchor: 补丁前 handleProxy 重建 body 只含 content/type/concepts/files,断言必红
    cmd: |-
      npx vitest run test/mcp-standalone-proxy.test.ts -t "FR-2 "
    expect_exit: 0
    expect_out: "Tests +([2-9]|[1-9][0-9]+) passed"
```

## FR-3 | `tools-registry.ts` memory_save inputSchema 补 agentId

两条判据缺一不可:①schema 行为断言;②技能文档一致性——`scripts/skills/generate.ts:68-84` 从 `inputSchema.properties` 生成 `plugin/skills/agentmemory-mcp-tools/REFERENCE.md` 的参数表(现场核实),schema 加字段后不重跑 `npm run skills:gen` 会被 `skills:check` 判 DRIFT。**这条同时回答 PRD 开放问题 3:需要执行 `npm run skills:gen` 并提交重生成结果。**

```yaml
cases:
  - id: C-FR3-1
    fr: FR-3
    owner: backend-dev
    desc: getAllTools() 的 memory_save schema 含 string 型 agentId,且 required 与工具总数不变
    red_anchor: 补丁前 properties 只有 content/type/concepts/files/project,断言必红
    cmd: |-
      npx vitest run test/memory-scope-isolation.test.ts -t "FR-3 "
    expect_exit: 0
    expect_out: "Tests +([2-9]|[1-9][0-9]+) passed"
  - id: C-FR3-2
    fr: FR-3
    owner: backend-dev
    desc: schema 改动后技能参考文档已重生成,skills:check 无 DRIFT
    red_anchor: s2a 现场实跑基线 exit 0;改 schema 而不跑 skills:gen 则 exit 1 并打印 DRIFT
    cmd: |-
      npm run skills:check
    expect_exit: 0
```

## FR-4 | `server.ts` memory_save 分支转发 `args.agentId`

用例落点:`test/memory-scope-isolation.test.ts`,用该文件内自带的 `mockKV/mockSdk/makeReq` 脚手架(照抄 `test/mcp-resources.test.ts:10-66`)驱动真实 `registerMcpEndpoints`,以 `overrideTrigger("mem::remember")` 捕获 payload。至少两条:①透传;②未传时 payload 不含该字段且既有 `project` 透传不受影响。

```yaml
cases:
  - id: C-FR4-1
    fr: FR-4
    owner: backend-dev
    desc: /agentmemory/mcp/call 的 memory_save 分支把 args.agentId 带进 mem::remember payload
    red_anchor: 补丁前 payload 逐字段展开无 agentId,断言必红
    cmd: |-
      npx vitest run test/memory-scope-isolation.test.ts -t "FR-4 "
    expect_exit: 0
    expect_out: "Tests +([2-9]|[1-9][0-9]+) passed"
```

## FR-5 | `api::remember` 接受 `body.agentId`

用例落点:`test/memory-scope-isolation.test.ts`,取 `sdk.getFunction("api::remember")` 直接调用 + `overrideTrigger("mem::remember")` 断言 payload。**不得使用 `readFileSync`+正则匹配源码文本的伪行为测试**(`memories-pagination.test.ts` 等三个文件是这类写法,不可参照)。至少三条:①正常长度透传;②超过 128 字符截断到 128;③缺失/空串时为 `undefined` 且不报错。

```yaml
cases:
  - id: C-FR5-1
    fr: FR-5
    owner: backend-dev
    desc: api::remember 按 session::start 既有写法解析 agentId(trim + 128 截断 + 空值兜底)并送达 mem::remember
    red_anchor: 补丁前请求体泛型与 payload 均无 agentId,三条断言全红
    cmd: |-
      npx vitest run test/memory-scope-isolation.test.ts -t "FR-5 "
    expect_exit: 0
    expect_out: "Tests +([3-9]|[1-9][0-9]+) passed"
```

## FR-6 | D10:systemd 切到工作树构建产物并真实生效

两条判据分别对应"配置改对了"与"服务真的在用新代码跑"(坑库 P28,缺一不可):
- `C-FR6-1` 证明 unit 两行都指向工作树 `dist/cli.mjs`、服务 active、探活通;
- `C-FR6-2` 走真实 REST 写入 + 独立读回,**每次运行用带时间戳的一次性 agentId**,杜绝"上一轮留下的历史记录让本轮假绿"。

```yaml
cases:
  - id: C-FR6-1
    fr: FR-6
    owner: devops-engineer
    desc: ExecStart 与 ExecStopPost 两行均指向工作树 dist/cli.mjs,服务 active 且 livez 返回 200
    red_anchor: s2a 现场实跑 exit 1,输出 ExecStart 未指向工作树产物(实际指向 nvm 全局包)
    cmd: |-
      bash -c 'set -uo pipefail; T=/home/ky/git/source-project/agentmemory/dist/cli.mjs; for P in ExecStart ExecStopPost; do V=$(systemctl --user show agentmemory -p $P --value); case "$V" in *"$T"*) ;; *) echo "$P 未指向工作树产物: $V"; exit 1;; esac; done; [ "$(systemctl --user is-active agentmemory)" = active ] || { echo "服务非 active"; exit 1; }; [ "$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3111/agentmemory/livez)" = 200 ] || { echo "livez 非 200"; exit 1; }'
    expect_exit: 0
  - id: C-FR6-2
    fr: FR-6
    owner: devops-engineer
    desc: 向真实 worker 发一次带 agentId/project 的 REST 写入,按该 agentId 读回计数不小于 1,证明跑的是补丁后的代码
    red_anchor: s2a 现场实跑 exit 1,读回 latestCount 0 / total 0(agentId 被旧代码丢弃)
    cmd: |-
      bash -c 'set -uo pipefail; S="${AGENTMEMORY_SECRET:-}"; if [ -z "$S" ]; then set -a; . "$HOME/.config/agentmemory/service.env"; set +a; S="${AGENTMEMORY_SECRET:-}"; fi; [ -n "$S" ] || { echo "AGENTMEMORY_SECRET 不可得"; exit 1; }; A=probe-msi-rest-$(date +%s)-$$; curl -fsS -X POST "http://localhost:3111/agentmemory/remember" -H "Authorization: Bearer $S" -H "Content-Type: application/json" -d "{\"content\":\"gate probe FR-6 rest write path $A\",\"type\":\"fact\",\"concepts\":[\"pipeline-probe\",\"memory-scope-isolation\"],\"agentId\":\"$A\",\"project\":\"agentmemory\"}" >/dev/null; sleep 2; curl -fsS -H "Authorization: Bearer $S" "http://localhost:3111/agentmemory/memories?agentId=$A&count=true" | jq -e ".total >= 1" >/dev/null'
    expect_exit: 0
```

## FR-7 | MCP stdio 主路径切到工作树构建产物

**作用对象已拍板为两份文件**(用户 s2b 呈批,design.md ADR-2 / R-3):仓库 `plugin/.mcp.json`(发布态、受版本控制)与插件缓存里客户端实际加载的那份(运行态、`~/.claude` 域、不受版本控制),两者 command/args 必须逐字一致。四条用例按 P28 拆"配置(两份)/ 制品真跑 / 客户端真连":
- `C-FR7-1` 配置层·仓库:`plugin/.mcp.json` 的 command/args 指向工作树 `dist/standalone.mjs` 且该产物存在;
- `C-FR7-1b` 配置层·运行态:**客户端实际加载的那份** `.mcp.json` 同样指向工作树产物,且与仓库那份 command/args 完全一致。目标路径从 `~/.claude/plugins/installed_plugins.json` 的 `agentmemory@agentmemory` → `installPath` 动态取(而非写死 0.9.28 目录),插件版本升级换目录后本用例仍指向真正被加载的那份;取不到时回落到 `~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28`。这条同时是"插件更新把缓存那份铺回旧内容"的探测器(ADR-2 代价②);
- `C-FR7-2` 制品层:**照 `plugin/.mcp.json` 里写的 command/args 原样起进程**,走真实 MCP stdio 协议(initialize → notifications/initialized → tools/call memory_save),再按一次性 agentId 从 worker 读回计数。守卫:command 必须是 `node` 且 args 命中工作树产物才执行,避免误触发 `npx` 联网安装。用仓库那份起进程即可覆盖两份——`C-FR7-1b` 已把"两份一致"钉成硬判据,不一致时先在 1b 判红;
- `C-FR7-3` 客户端层:真实 MCP 客户端重启/重连后的观察,**标 `manual`**——脚本无法驱动宿主客户端重连。性质不变,覆盖对象扩展为两份文件(既确认重连后跑的是工作树产物,也确认两份文件在观察时点都仍在位)。

```yaml
cases:
  - id: C-FR7-1
    fr: FR-7
    owner: devops-engineer
    desc: 仓库 plugin/.mcp.json 以 node 直接执行工作树 dist/standalone.mjs,且该产物存在
    red_anchor: s2a 现场实跑 exit 1,输出 command 非 node(实际为 npx)
    cmd: |-
      bash -c 'set -uo pipefail; R=/home/ky/git/source-project/agentmemory; T=$R/dist/standalone.mjs; C=$(jq -r ".mcpServers.agentmemory.command" $R/plugin/.mcp.json); A=$(jq -r ".mcpServers.agentmemory.args | join(\" \")" $R/plugin/.mcp.json); [ "$C" = node ] || { echo "command 非 node: $C"; exit 1; }; case "$A" in *"$T"*) ;; *) echo "args 未指向工作树产物: $A"; exit 1;; esac; [ -f "$T" ] || { echo "构建产物不存在: $T"; exit 1; }'
    expect_exit: 0
  - id: C-FR7-1b
    fr: FR-7
    owner: devops-engineer
    desc: 客户端实际加载的那份 .mcp.json(installed_plugins.json 指向的插件缓存)同样以 node 执行工作树 dist/standalone.mjs,且与仓库那份 command/args 逐字一致
    red_anchor: s2a/s2b 现场实测缓存那份内容与仓库同为 npx -y @agentmemory/mcp,command 非 node,判红
    cmd: |-
      bash -c 'set -uo pipefail; R=/home/ky/git/source-project/agentmemory; T=$R/dist/standalone.mjs; I=$HOME/.claude/plugins/installed_plugins.json; P=$(jq -r ".plugins[\"agentmemory@agentmemory\"][0].installPath // empty" "$I" 2>/dev/null); [ -n "$P" ] || P=$HOME/.claude/plugins/cache/agentmemory/agentmemory/0.9.28; M=$P/.mcp.json; [ -f "$M" ] || { echo "客户端加载的 mcp 配置不存在: $M"; exit 1; }; C=$(jq -r ".mcpServers.agentmemory.command" "$M"); A=$(jq -r ".mcpServers.agentmemory.args | join(\" \")" "$M"); [ "$C" = node ] || { echo "缓存那份 command 非 node: $C ($M)"; exit 1; }; case "$A" in *"$T"*) ;; *) echo "缓存那份 args 未指向工作树产物: $A"; exit 1;; esac; [ -f "$T" ] || { echo "构建产物不存在: $T"; exit 1; }; RC=$(jq -r ".mcpServers.agentmemory.command" $R/plugin/.mcp.json); RA=$(jq -r ".mcpServers.agentmemory.args | join(\" \")" $R/plugin/.mcp.json); { [ "$C" = "$RC" ] && [ "$A" = "$RA" ]; } || { echo "两份配置不一致: 缓存[$C $A] 仓库[$RC $RA]"; exit 1; }'
    expect_exit: 0
  - id: C-FR7-2
    fr: FR-7
    owner: devops-engineer
    desc: 按 plugin/.mcp.json 原样起 MCP stdio 进程调 memory_save,worker 侧按一次性 agentId 读回计数不小于 1
    red_anchor: s2a 用等价 scratch 配置现场实跑 exit 1(读回 total 0);同链路真实 tools/call 已跑通,返回的 memory 记录里无 agentId/project 字段
    cmd: |-
      bash -c 'set -uo pipefail; R=/home/ky/git/source-project/agentmemory; T=$R/dist/standalone.mjs; C=$(jq -r ".mcpServers.agentmemory.command" $R/plugin/.mcp.json); A=$(jq -r ".mcpServers.agentmemory.args | join(\" \")" $R/plugin/.mcp.json); [ "$C" = node ] || { echo "command 非 node: $C"; exit 1; }; case "$A" in *"$T"*) ;; *) echo "args 未指向工作树产物: $A"; exit 1;; esac; S="${AGENTMEMORY_SECRET:-}"; if [ -z "$S" ]; then set -a; . "$HOME/.config/agentmemory/service.env"; set +a; S="${AGENTMEMORY_SECRET:-}"; fi; [ -n "$S" ] || { echo "AGENTMEMORY_SECRET 不可得"; exit 1; }; G=probe-msi-mcp-$(date +%s)-$$; printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"gate\",\"version\":\"0\"}}}" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_save\",\"arguments\":{\"content\":\"gate probe FR-7 mcp stdio $G\",\"type\":\"fact\",\"concepts\":\"pipeline-probe,memory-scope-isolation\",\"agentId\":\"$G\",\"project\":\"agentmemory\"}}}" | AGENTMEMORY_URL=http://localhost:3111 AGENTMEMORY_SECRET="$S" timeout 60 $C $A >/dev/null 2>&1; sleep 2; curl -fsS -H "Authorization: Bearer $S" "http://localhost:3111/agentmemory/memories?agentId=$G&count=true" | jq -e ".total >= 1" >/dev/null'
    expect_exit: 0
  - id: C-FR7-3
    fr: FR-7
    owner: devops-engineer
    manual: true
    reason: 需人工重启或重连宿主 MCP 客户端后发一次 memory_save 并核验落库记录带 agentId,脚本无法确定性驱动宿主客户端重连;覆盖对象为已拍板的两份 .mcp.json(仓库 plugin/.mcp.json + installed_plugins.json 指向的插件缓存那份,design.md ADR-2/R-3),观察时点须确认两份都仍指向工作树 dist/standalone.mjs
```

## 回归判据(既有资产不许被本次改动打坏)

`gate.sh` 的 tests 项会跑全量 `npm test`,但本机全量基线**本身就红**(s2a 实测 12 失败 / 5 文件:11 条由 `~/.agentmemory/.env` 泄漏进测试进程导致、`HOME` 隔离后消失,1 条是 HEAD 上 `consistency.test.ts` 的 README 端点计数漂移;详见 design.md 风险 R-2)。因此本清单另立一条**与本次改动直接相关、基线实测全绿**的回归子集,作为可判定的硬判据。

```yaml
cases:
  - id: C-REG-1
    fr: FR-1
    owner: backend-dev
    desc: 与五处补丁相关的既有测试(schema 消费方 3 + memoryToObservation 消费方 3 + 作用域读侧 2 + MCP 两条路径)保持全绿
    red_anchor: s2a 现场实跑基线 Test Files 9 passed (9) / Tests 97 passed (97),exit 0
    cmd: |-
      npx vitest run test/mcp-standalone.test.ts test/mcp-surface-default.test.ts test/tool-count-consistency.test.ts test/governance.test.ts test/remember-forget-audit.test.ts test/agent-isolation-search.test.ts test/agent-id-scope.test.ts test/mcp-resources.test.ts test/mcp-standalone-proxy.test.ts
    expect_exit: 0
    expect_out: "Test Files +9 passed"
```

## 副作用与清理(执行前须知)

- `C-FR6-2`/`C-FR7-2` 每跑一次向**真实记忆库**写入一条探针记录(`concepts` 含 `pipeline-probe`,`agentId` 形如 `probe-msi-*`)。这是 PRD FR-6 明确认可的核验方式("可发一次真实 memory_save 请求核验落库记录"),代价是每轮 gate 留 2 条探针记录。清理是可选且属破坏性操作:要清理须先按 `concepts=pipeline-probe` 列出待删清单交人确认,**确认在删除之前**(坑库 P34);本清单不内置任何删除动作。
- `C-FR7-1b` 读 `~/.claude` 下的用户配置(只读,不写);该目录内容不受本仓库版本控制,插件更新会覆盖 —— 判红时先分辨是"实现没做"还是"做了之后被插件更新冲回"(design.md ADR-2 代价②),两者处置不同(前者回派 B2,后者重做一次 B2 的缓存侧写入)。
- `C-FR6-1`/`C-FR6-2`/`C-FR7-2` 依赖 systemd user 会话与本机 3111 端口 worker;在无 systemd 或 worker 未起的环境下必红,属**环境不满足**而非实现缺陷,由 qa-tester 在 test-report.md 里区分标注。
