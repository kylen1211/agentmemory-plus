---
change_id: memory-scope-isolation
grade: L3
contract_tier: cases
stage: s6
stage_status: running
pending: PRD/设计/契约/任务卡待批(一次呈批,s2b step4);核心待拍板项见 act_msshmgwu(FR-7 mcp配置实际生效路径未证实);次要跟进见 act_msshmki7(agent-mem CLI补agentId,repo外)
base_commit: d60652a7058773fa9428fa720eda38942f12f014
loop_counts:
  implement: 0
  integrate: 0
  review: 1
rollback_count: 0
frozen:
  prd:
    hash: 9ec16c059ff210f5cd9ba78e4eb9d407455dd2df6d7ea7b8e3cc2921dfe012da
  contract:
    hash: 08f7a619fcb8591ca029789d6e61a288e3fcbd0e5f0eb95a75c1262ce83563cd
    based_on: 9ec16c059ff210f5cd9ba78e4eb9d407455dd2df6d7ea7b8e3cc2921dfe012da
  tasks:
    hash: dbd1a631240a29c8d129a317dac458beae7b410949d66334243422b5bd932ea5
    based_on: 08f7a619fcb8591ca029789d6e61a288e3fcbd0e5f0eb95a75c1262ce83563cd
approvals:
- point: prd
  at: 2026-08-14 13:40:52
  hash: 9ec16c059ff210f5cd9ba78e4eb9d407455dd2df6d7ea7b8e3cc2921dfe012da
- point: contract
  at: 2026-08-14 13:40:52
  hash: 08f7a619fcb8591ca029789d6e61a288e3fcbd0e5f0eb95a75c1262ce83563cd
worktrees: []
generated:
- path: pipeline/memory-scope-isolation/generated/run-cases.sh
  hash: 27bdfa8ab60e00b2677f1c0a55b6940e2eec088f3436a15cfc465aa47b859f77
- path: pipeline/memory-scope-isolation/generated/cases/C-FR1-1.sh
  hash: 2e49c80e12f1e5d5c4b0c2cae81e8f6d25b925768e1528a919d74fa330f95f62
- path: pipeline/memory-scope-isolation/generated/cases/C-FR2-1.sh
  hash: 116949b856776e9fff7d2242798a6a6efacb6d342d5ffc6adb2241e42091502d
- path: pipeline/memory-scope-isolation/generated/cases/C-FR3-1.sh
  hash: 8e415329a2e756aadceca8603f16af38cdcb4a927ed12637fb320eb17ee1c482
- path: pipeline/memory-scope-isolation/generated/cases/C-FR3-2.sh
  hash: 1f184ab46a088ced8ab6c7286e235a6dcdd04c881c4fb1b54f4ec55867e7a448
- path: pipeline/memory-scope-isolation/generated/cases/C-FR4-1.sh
  hash: 6345ac28041460977dc2c1386530726fe86a77cedacc17251703d4acf414cdca
- path: pipeline/memory-scope-isolation/generated/cases/C-FR5-1.sh
  hash: ba624911e2edc882ecf2ab31147856373cd66b17e103f6a5c9aef7c91900d805
- path: pipeline/memory-scope-isolation/generated/cases/C-FR6-1.sh
  hash: d3c0087af2cca7994d745a26a866981354e352a43b0df61efb15c0065e8d0986
- path: pipeline/memory-scope-isolation/generated/cases/C-FR6-2.sh
  hash: a81143b45268afef7ddf4033a262d4cef3406e3a80f72d2ef231e55d5b43d721
- path: pipeline/memory-scope-isolation/generated/cases/C-FR7-1.sh
  hash: 543522b9ec1b29cd569e9c24c658365c16ace4f8306be0b76d756bd6de041c6a
- path: pipeline/memory-scope-isolation/generated/cases/C-FR7-1b.sh
  hash: 16651389b5a33a6e9b3b0ab0ca7581f61b627281d13f04681e180443a2bb606c
- path: pipeline/memory-scope-isolation/generated/cases/C-FR7-2.sh
  hash: e268e9b7b5b30a6911064b083ed714c134007f3f0f3677f5fbb8b919a283f69d
- path: pipeline/memory-scope-isolation/generated/cases/C-REG-1.sh
  hash: b61694fa6f915c5301bb6f6bc48053d7f435f499983123c4da81d89c26f75de6
uncovered:
- id: C-FR7-3
  reason: 需人工重启/重连宿主MCP客户端观察;已拍板(design.md R-3)FR-7目标扩为仓库plugin/.mcp.json与客户端实际加载的插件缓存两份同改,C-FR7-1b已作为可执行判据覆盖两份内容一致性,本条manual仅覆盖'实测重启后agentId真正生效'这一步
  status: accepted
parked:
- id: P-001
  item: C-FR7-2首跑瞬态失败
  reason: T-B2首次跑C-FR7-2曾红(读回total=0),复测8+次后稳定PASS,devops判定为worker冷启动类一次性瞬态非代码缺陷;若下次变更gate复跑再现同类偶发红,先重跑2-3次排除瞬态,仍持续红才升级backend-dev定位mem::remember写入路径
  status: observe
  ttl: 2026-11-12
  on_expiry: escalate
budget:
  limit_tokens: null
  spent_note: null
---
2026-08-14T11:42:24 init change_id=memory-scope-isolation
2026-08-14T11:43:11 set base_commit=d60652a7058773fa9428fa720eda38942f12f014
2026-08-14T11:43:11 set grade=L3
2026-08-14T11:43:11 set contract_tier=cases
2026-08-14T11:43:11 判级: L3(命中'波及≥3模块': src/state + src/mcp + src/triggers,四处必改补丁 + D10 worker 源码构建切换前置);契约档位预判: cases(修复既有 REST/MCP 接口的字段透传缺陷,不新增接口/schema,验收以 evidence/scope-isolation.sh 六组对照为准,s2a 终定)
2026-08-14T11:43:15 set stage_status=done
2026-08-14T11:43:16 set stage=s1a
2026-08-14T11:43:16 set stage_status=running
2026-08-14T12:21:26 stage=s1a research done files=research/intake.md,research/facts.md,research/codebase-survey.md,research/build-spike.md;关键发现:原4处必改清单证伪,实为5处必改(补丁2扩为3处+新增5b tools-registry.ts schema+ExecStopPost同改)+1处软性(5c本期不修,用户拍板延后);用户已批复:MCP补丁生效方式改.mcp.json指向工作树构建产物、分支起点基于当前HEAD直接开分支、验收范围补齐三写入路径端到端用例
2026-08-14T12:21:26 set stage_status=done
2026-08-14T12:21:29 set stage=s1b
2026-08-14T12:21:29 set stage_status=running
2026-08-14T12:46:58 stage=s1b prd done, pipeline-check exit=0; FR-1~FR-7(全P0)+8条非目标+3条开放问题;上一轮PM agent因stream watchdog超时failed(已产出问题陈述节),重派后顺利补完
2026-08-14T12:46:58 set stage_status=done
2026-08-14T12:47:01 set stage=s2a
2026-08-14T12:47:01 set stage_status=running
2026-08-14T13:09:54 stage=s2a design+contract done,出口判据主会话复跑确认:pipeline-check design exit=0,gen-contract --dry-run exit=10(partial,C-FR7-3 manual,预期内);6条ADR;清理s2a验证产生的3条探针记忆(mem_mssh0sw5/mem_mssh14q3/mem_mssh2grz已删);核心待拍板项已记act_msshmgwu(FR-7改的.mcp.json可能非客户端实际加载那份,不阻塞s2b,阻塞s3/s4落地FR-7前);次要跟进已记act_msshmki7(agent-mem CLI补agentId,repo外后续排期);R-2(gate全量测试基线本身12条红,与本次无关)已在design.md记录方向,s5前处置,不阻塞当前阶段
2026-08-14T13:09:54 set stage_status=done
2026-08-14T13:09:58 set stage=s2b
2026-08-14T13:09:58 set stage_status=running
2026-08-14T13:19:04 set uncovered[+]={id: C-FR7-3, reason: "需人工重启/重连宿主MCP客户端观察;且客户端实际加载的mcp配置文件待拍板(design.md R-3, act_msshmgwu)", status: pending}
2026-08-14T13:19:29 stage=s2b tasks 拆卡完成,9张任务卡(组A backend-dev T-A1~A6 线性依赖链,组B devops-engineer T-B0~B2);排干闸门主会话复跑确认:gen-contract --dry-run exit=10(partial,C-FR7-3已登记uncovered),pipeline-check tasks exit=0;已知瑕疵:组A由并行改线性(共享测试文件独占路径冲突,已接受);无任务卡负责建分支(ADR-6要求基于当前HEAD开分支,需在s4派发前由主会话/下一会话执行);base_commit记录时点(d60652a)与PRD文中引用(acb7772)均为pipeline自身commit,不影响功能(均不触及src/),真正分支点=s4实际执行时的HEAD
2026-08-14T13:19:29 set stage_status=waiting_human
2026-08-14T13:19:29 set pending=PRD/设计/契约/任务卡待批(一次呈批,s2b step4);核心待拍板项见 act_msshmgwu(FR-7 mcp配置实际生效路径未证实);次要跟进见 act_msshmki7(agent-mem CLI补agentId,repo外)
2026-08-14T13:29:29 2026-08-14T13:29:29 用户批复:s2b一次呈批[E]部分意见——PRD/契约/任务卡整体批准,但R-3(FR-7目标文件)用户拍板改为'两份都改'(仓库内plugin/.mcp.json + 客户端实际加载的插件缓存~/.claude/plugins/cache/agentmemory/agentmemory/0.9.28/.mcp.json均切到工作树构建产物),需回s2a更新design.md R-3/ADR-2记录+T-B2任务卡+contract用例覆盖两份文件,按s2a→s2b顺序重跑到本闸门再呈批
2026-08-14T13:29:30 set stage=s2a
2026-08-14T13:29:30 set stage_status=running
2026-08-14T13:36:30 2026-08-14T13:36:30 stage=s2a 出口判据复核:pipeline-check design exit=0,gen-contract --dry-run exit=10(partial,可生成用例11→12,新增C-FR7-1b);design.md R-3由待拍板改为已拍板(两份都改)+ADR-2/组B-B2同步更新,contract/cases.md新增C-FR7-1b+扩写FR-7/C-FR7-3;主会话复核通过
2026-08-14T13:36:30 set stage_status=done
2026-08-14T13:36:31 set stage=s2b
2026-08-14T13:36:31 set stage_status=running
2026-08-14T13:36:37 set uncovered[0].reason=需人工重启/重连宿主MCP客户端观察;已拍板(design.md R-3)FR-7目标扩为仓库plugin/.mcp.json与客户端实际加载的插件缓存两份同改,C-FR7-1b已作为可执行判据覆盖两份内容一致性,本条manual仅覆盖'实测重启后agentId真正生效'这一步
2026-08-14T13:40:52 set frozen.prd.hash=9ec16c059ff210f5cd9ba78e4eb9d407455dd2df6d7ea7b8e3cc2921dfe012da
2026-08-14T13:40:52 set approvals[+]={point: prd, at: 2026-08-14T13:40:52, hash: 9ec16c059ff210f5cd9ba78e4eb9d407455dd2df6d7ea7b8e3cc2921dfe012da}
2026-08-14T13:40:52 set frozen.contract={hash: 08f7a619fcb8591ca029789d6e61a288e3fcbd0e5f0eb95a75c1262ce83563cd, based_on: 9ec16c059ff210f5cd9ba78e4eb9d407455dd2df6d7ea7b8e3cc2921dfe012da}
2026-08-14T13:40:52 set approvals[+]={point: contract, at: 2026-08-14T13:40:52, hash: 08f7a619fcb8591ca029789d6e61a288e3fcbd0e5f0eb95a75c1262ce83563cd}
2026-08-14T13:40:52 set frozen.tasks={hash: dbd1a631240a29c8d129a317dac458beae7b410949d66334243422b5bd932ea5, based_on: 08f7a619fcb8591ca029789d6e61a288e3fcbd0e5f0eb95a75c1262ce83563cd}
2026-08-14T13:40:52 set stage_status=done
2026-08-14T13:41:03 2026-08-14T13:41:03 stage=s2b 一次呈批冻结完成:用户批准+R-3已拍板(两份都改)落地,排干闸门②-⑤最终复核 gen-contract exit=10(partial,C-FR7-3)/pipeline-check tasks exit=0;frozen.prd/contract/tasks 三级 hash 与 approvals 均已记账
2026-08-14T13:41:03 set stage=s3
2026-08-14T13:41:03 set stage_status=running
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/run-cases.sh, hash: 27bdfa8ab60e00b2677f1c0a55b6940e2eec088f3436a15cfc465aa47b859f77}
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR1-1.sh, hash: 2e49c80e12f1e5d5c4b0c2cae81e8f6d25b925768e1528a919d74fa330f95f62}
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR2-1.sh, hash: 116949b856776e9fff7d2242798a6a6efacb6d342d5ffc6adb2241e42091502d}
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR3-1.sh, hash: 8e415329a2e756aadceca8603f16af38cdcb4a927ed12637fb320eb17ee1c482}
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR3-2.sh, hash: 1f184ab46a088ced8ab6c7286e235a6dcdd04c881c4fb1b54f4ec55867e7a448}
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR4-1.sh, hash: 6345ac28041460977dc2c1386530726fe86a77cedacc17251703d4acf414cdca}
2026-08-14T13:49:34 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR5-1.sh, hash: ba624911e2edc882ecf2ab31147856373cd66b17e103f6a5c9aef7c91900d805}
2026-08-14T13:49:35 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR6-1.sh, hash: d3c0087af2cca7994d745a26a866981354e352a43b0df61efb15c0065e8d0986}
2026-08-14T13:49:35 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR6-2.sh, hash: a81143b45268afef7ddf4033a262d4cef3406e3a80f72d2ef231e55d5b43d721}
2026-08-14T13:49:35 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR7-1.sh, hash: 543522b9ec1b29cd569e9c24c658365c16ace4f8306be0b76d756bd6de041c6a}
2026-08-14T13:49:35 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR7-1b.sh, hash: 16651389b5a33a6e9b3b0ab0ca7581f61b627281d13f04681e180443a2bb606c}
2026-08-14T13:49:35 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-FR7-2.sh, hash: e268e9b7b5b30a6911064b083ed714c134007f3f0f3677f5fbb8b919a283f69d}
2026-08-14T13:49:35 set generated[+]={path: pipeline/memory-scope-isolation/generated/cases/C-REG-1.sh, hash: b61694fa6f915c5301bb6f6bc48053d7f435f499983123c4da81d89c26f75de6}
2026-08-14T13:49:46 stage=s3 生成完成:gen-contract exit=10(partial),13个生成物(1个run-cases.sh+12个用例脚本)已登记generated[];PARTIAL C-FR7-3 与 s2b 已登记的 uncovered 条目一致(预期内,manual,不重复登记),不阻塞进入 s4
2026-08-14T13:49:46 set stage_status=done
2026-08-14T13:49:46 set stage=s4
2026-08-14T13:49:46 set stage_status=running
2026-08-14T13:50:50 stage=s4 dispatch backend-dev T-A1
2026-08-14T13:53:51 T-A1 DONE commits d86f67e
2026-08-14T13:53:51 stage=s4 dispatch backend-dev T-A2
2026-08-14T13:55:37 T-A2 DONE commits bb85a9a
2026-08-14T13:55:37 stage=s4 dispatch backend-dev T-A3
2026-08-14T13:58:29 T-A3 DONE commits 29c84a9
2026-08-14T13:58:29 stage=s4 dispatch backend-dev T-A4
2026-08-14T14:00:23 T-A4 DONE commits 3c06ab6
2026-08-14T14:00:23 stage=s4 dispatch backend-dev T-A5
2026-08-14T14:02:45 T-A5 DONE commits 31bb4bd
2026-08-14T14:02:45 stage=s4 dispatch backend-dev T-A6
2026-08-14T14:04:09 T-A6 DONE 组A收口回归全绿(C-REG-1 9/9 + 六条FR用例)
2026-08-14T14:04:09 stage=s4 dispatch devops-engineer T-B0
2026-08-14T14:06:04 T-B0 DONE dist/cli.mjs+dist/standalone.mjs已含补丁(grep agentId=10,mtime晚于源码),权限位噪音已复原
2026-08-14T14:08:24 用户已明确批准T-B1/T-B2并行执行(生产systemd重启+两份.mcp.json改写)
2026-08-14T14:08:24 stage=s4 dispatch devops-engineer T-B1
2026-08-14T14:08:24 stage=s4 dispatch devops-engineer T-B2
2026-08-14T14:11:24 T-B1 DONE systemd unit切工作树dist/cli.mjs,active+livez200,探针probe-msi-rest-1786687825-1871768读回total=1,C-FR6-1/C-FR6-2全绿
2026-08-14T14:17:05 T-B2 DONE 两份.mcp.json改写(command=node,args指向dist/standalone.mjs,env原样保留),C-FR7-1/1b/2全绿;deploy-runbook.md新建FR-7小节;plugin/.mcp.json未commit(留待s4m)
2026-08-14T14:17:05 set parked[+]={item: C-FR7-2首跑瞬态失败, reason: T-B2首次跑C-FR7-2曾红(读回total=0),复测8+次后稳定PASS,devops判定为worker冷启动类一次性瞬态非代码缺陷;若s5/s6 gate复跑再现同类偶发红先重跑2-3次排除瞬态再升级backend-dev定位mem::remember写入路径, status: observe}
2026-08-14T14:17:05 stage=s4 全部9张任务卡DONE(T-A1~A6+T-B0~B2),组A+组B完成
2026-08-14T14:17:05 set stage_status=done
2026-08-14T14:17:05 set stage=s4m
2026-08-14T14:17:05 set stage_status=running
2026-08-14T14:22:58 stage=s4m gate merge 首跑红:typecheck(25条)+tests(12条/5文件),经与base_commit d60652a7逐条比对确认typecheck 100%基线既有(仅api.ts 2条因本变更插入代码行号平移9行,内容不变)、tests中11条源于~/.agentmemory/.env泄漏(HOME隔离后消失,已实测1581 passed仅剩1条)、1条为test/consistency.test.ts README端点数漂移(base_commit同样复现);按design.md R-2预授权口径处置:tests用GATE_TEST_CMD追加HOME隔离+--exclude consistency.test.ts修复至PASS,typecheck与consistency.test.ts漂移登记入项目级pipeline/debts.md(D-001/D-002,ttl 2026-11-12);二次跑gate merge:generated-hash PASS/tests PASS/typecheck仍红(纯基线债务,判定不阻塞本变更)
2026-08-14T14:22:58 merged_green(判定依据:仅typecheck基线债务D-001阻挡,已核实与本变更五处补丁无关,主会话按design.md R-2预授权override)
2026-08-14T14:22:58 set stage_status=done
2026-08-14T14:22:58 set stage=s5
2026-08-14T14:22:58 set stage_status=running
2026-08-14T14:27:03 stage=s5 gate integrate 首跑:frozen PASS/generated-hash PASS/contract-runtime 12-12 PASS/tests PASS(HOME隔离+排除consistency.test.ts)/mutation FAIL(注入5存活4);逐一人工核实4处存活mutant均落在本变更未触碰代码:server.ts:22 asNonEmptyString()、standalone.ts:49 announceMode()、api.ts:34 parseOptionalInt() 为改动外既有helper(T-A3/T-A4/T-A5新增代码各自内联解析未调用它们),types.ts:445命中点落在注释文本内非可执行代码;判定为gate.sh变异测试机制'候选点=整文件首个正则匹配非diff hunk范围'的已知开放项噪音(gate.sh头注释自承"开放项默认值,首个L2变更进s5时复议"),非本变更实现缺陷;已记agentmemory lesson lsn_0fb0efede40e5d6d + action act_msskdy08_b8d7dbd06e31(改进方向:候选范围收紧到diff hunk行号),不派修复、不loop-inc
2026-08-14T14:27:03 s5 pass(判定依据:frozen/generated-hash/contract-runtime/tests四项真实PASS;mutation红经核实为机制噪音非实现缺陷,主会话override)
2026-08-14T14:27:03 set stage_status=done
2026-08-14T14:27:03 set stage=s6
2026-08-14T14:27:03 set stage_status=running
2026-08-14T14:27:43 gate-verdict.json 已更新为如实反映最终处置:overall pass=true,mutation项标注override=true+override_reason(详见评审依据),其余四项为原始真实PASS未改动
2026-08-14T14:47:23 loop review -> 1
2026-08-14T14:47:36 review round1: pass=false,3条Important(deploy-runbook缺FR-6小节/ADR-6分支未建/plugin/.mcp.json未提交无拦截),无Critical,无需返工组A五处补丁;Important-2主会话直接处置:在当前HEAD(c257afe)打分支memory-scope-isolation作为锚点,main未移动,不追溯到base_commit重建历史;Important-1/3派devops-engineer补deploy-runbook.md
2026-08-14T15:25:16 C-FR7-3 端到端验证完成:用户重启当前Claude CLI(claude --continue)重连agentmemory MCP,主会话在重连后的会话内实测 memory_save(content=probe-msi-c-fr7-3, agentId=probe-c-fr7-3)→写入mem_mssmgkww_860b276c0a66→memory_recall('probe-msi-c-fr7-3')服务端真实读回,结果agentId=probe-c-fr7-3完整持久化(非save响应回显,是独立recall调用命中);证明客户端重连后确实跑的是标 dist/standalone.mjs 补丁代码,FR-7 真正生效
2026-08-14T15:25:16 set uncovered[0].status=accepted
2026-08-14T15:25:16 uncovered C-FR7-3 → accepted(证据见上一行,非单纯人工口头接受,是真实端到端探针验证)
2026-08-14T15:25:53 修复parked条目YAML格式错误(自由文本含冒号未加引号导致误拆成多余key);补齐id/ttl/on_expiry字段;pipeline-check closeout 通过(exit 0)
