# TUI 用量边界修复与联合验收规格

日期：2026-10-08
状态：原 6 份规格的必做实现已落地；本批包含一个新确认的用量缺陷及剩余联合/终端验收。
核对基线：TUI `1bf9b7f30c9c13c5d18c129538ca66b9145f34ee`；core `2ebd226189b1edc4fcf502a3638152bbdec2907e`。
执行入口：[TUI prompt](2026-10-08-execution-prompt.md)；配对 [core 后续规格](../../pi-claude-code-core/spec/2026-10-08-followup-execution.md)。

## 1. 当前实现与证据范围

| 工作 | 已有实现 | 本轮处理 |
|---|---|---|
| P0-1 生命周期 | 4282bec，后续复审修复 458c119 / bcde056 / b3f5675 | 保留回归；真实 print/reload/off/on/退出清理待证据 |
| P0-2 core-bus | 955de27；2a7984f 对新 instance 重验 | 实例身份交接 fixture 已通过；真实宿主槽位和加载顺序仍 open |
| P1-1 工具显示 | 7319c74 | 不重做；真实 goal/obs/proxy/MCP 行待验收 |
| P1-2 用量 | 第一步 9accbaa；第二步 710c9c7；缺失 ctx 回退修复 1bf9b7f | 不再等待 core P2-4；本批仅修 U-F1 并补完整生产事件联调 |
| P2-1 ReplicaSession | 0287b86 与后续复审修复 | 已实施，保留真实 factory 接线回归 |
| P3-1 文档及小项 | D1–D7 已实施；D5 时序证据未取 | 补 XPKG-09-HOST 证据，D8 ANSI 合并可选仍不做 |

2026-10-08 当前基线 `npm test` 为 272 passed、0 skipped，`npm run typecheck` 退出 0；core check/test/contracts 均通过（unit 905 vitest + 490 node:test；contracts 40 passed + 3 todo）。测试日志 `/tmp/spec-refresh-20261008-*.log` 仅供本次核对，不作为永久依赖。新 U-F1 没有被当前 272 项覆盖，绿色基线不代表该缺陷不存在。

原报告“实现已完成、真机未做”继续保留。新发现单列，不把旧功能全量重新派发。可选 effort pin、ANSI 合并与发布仍不在本批必做范围。

## 2. U-F1 回退百分比与窗口分母必须同源

### 2.1 已复现问题

`extensions/lib/status-snapshot.ts#selectDisplayUsage` 在 core 累计通道有效、仅有 `contextWindow` 而无 `ctxTokens/ctxPercent` 时，百分比与 tokens 回退 tracker/host，但最终返回的 `contextWindow` 仍优先 coreWindow。

以真实函数调用复现：

```text
tracker.used = 50_000
hostContextWindow = 200_000
core = { input: 1_200_000, output: 30_000, cacheRead: 500_000,
         cacheWrite: 0, cost: 1.5, contextWindow: 1_000_000 }
当前返回：usedPercent=25, usedTokens=50_000, contextWindow=1_000_000
buildStatusRightGroup 实际输出：example | Ctx 25%(50k/1.0M) | $1.50
```

core P2-4 明确允许可选 ctx 字段独立缺失，所以上述是合法输入。问题同样传入 `ReplicaSession#buildStatuslineInput`：选中的百分比按 200k 计算，JSON 的 window 却为 1M。这是展示来源混用，非模型计费或累计值问题。

### 2.2 修复规则

将 ctx 的来源选择视为一个完整结果 `{ usedPercent, usedTokens, contextWindow }`；cost 与累计总量继续独立按既有 core 优先规则选择。

| 可用来源 | ctx 选择 |
|---|---|
| core ctxPercent 有效 | 保留宿主百分比的既有 clamp/round，不用 tokens/window 强行重新计算；tokens 只取 core，有值才提供比例文本；window 取 core，有需要时沿用 host 回退 |
| core 无 percent，有 ctxTokens | tokens 取 core；window 取有效 coreWindow，否则 hostWindow；只有有效分母时推导百分比 |
| core 无 percent，也无 tokens | tokens、百分比与 window **整体取 tracker + hostWindow**；即使 coreWindow 有效也不得混入此组 |
| 无 core 通道 | 维持既有 tracker 路径 |

本缺陷输入修后应为 25%、50k、200k，右侧比例为 `25%(50k/200k)`；累计 cost=1.5 等仍来自 core。真实 ctxPercent=0 / ctxTokens=0 保持真实零，不能改为 truthy 判断。核心已经提供的百分比可能与 token 比例口径不同，不能泛化成“所有情况下 percent 必须等于 tokens/window”；本项只修回退来源混用。

现有非法可选字段使 readCoreUsage 整体回退的保守行为保持，记录其范围；不借 U-F1 扩大到 normalization 重写。

### 2.3 验收

- U-F1a：上述精确输入先红后绿，同时断言 usedPercent、usedTokens、contextWindow、cost 与累计 totals。
- U-F1b：真实右侧渲染与实际 session statusline 输入 JSON 均采用 200k；不是仅测 select helper。core 后续提供完整 ctx 数据时切回正确 core 来源。
- U-F1c：core/host window 相等与不同、仅 percent、仅 tokens、真实 0、通道清空/new/reload 组合保持；保留 1bf9b7f 的缺失 ctx 回退测试。
- `npm test` / `npm run typecheck` 通过；同步中英说明与 CHANGELOG，不改 JSON 字段名/类型、不扩大模型可见行为。

## 3. J-USAGE 完整生产事件至显示验证

当前 `test/core-bus.joint.test.ts` 的 C7-usage 用真实 core bus，但 `usage` 由测试直接写 payload；它证明传输/消费形状，**未证明真实 modes 事件生产 → TUI 状态行/JSON 的完整接线**。保留现有测试，不把它改名后冒充新证据。

补充跨仓 fixture：加载真实 core modes producer 与本仓实际 factory / ReplicaSession 接线，通过可控宿主 adapter 驱动现有 session/message/usage 事件，使 production `refreshWorkingMessage` 发布真实 `modes.usage`，再断言 TUI 状态行与 statusline JSON。同一验证中不得用手工 `bus.publish({usage: ...})` 替代被验证的生产步骤。

覆盖 core-first / TUI-first，core 晚于 TUI 本地刷新发布时仍更新，cost/ctx 同源，0/可选缺失、new/reload 清空、旧 core / 无 core 回退。确保跨仓套件实际执行而非 sibling 缺席跳过；记录双方 revision 和真实加载的路径。固定 core revision 或完整源快照验证，不能读取另一 agent 正在改写的一半代码。

依赖的 XPKG-08 已登记。若新测试涉及额外宿主契约，先将拟登记内容交回 core 任务记录，按契约流程处理；不要跨仓擅自修改其测试/契约。此项使用可控 adapter，依旧不是下面的真实终端验收。

## 4. H-TUI 真实终端与宿主时序

以 [manual-verification](../docs/manual-verification.md) §11、§12、§12.5、§13 为操作清单，在隔离 agentDir / 项目下执行，核实当前宿主 CLI 的实际参数和环境入口。优先使用已有 PTY/终端自动化能力，不把“需真机”直接等同于必须等待用户操作。

| ID | 场景与证据 |
|---|---|
| H-T1 | print 模式无 thinking tip / packed display entry；reload 通知与 off→on 生命周期；退出时直接 statusline child 终止，无迟到重启 |
| H-T2 | force goal rows、schema fallback、obs_recall 分页与错误原文、proxy/direct/bare MCP 的真实显示；不改工具执行内容 |
| H-T3 | 用量在 script 有效/等待/空/错误、关闭及 native footer 下正确归属；真实零/缺失回退；状态行与脚本无本包引入的重复或来源冲突 |
| H-T4 | 两种扩展加载顺序与可重复配置告警、reload、off/on、TUI 加载失败后 core 实际安装 footer、经济模块降级行；记录实际槽位而非仅 presence 布尔值 |
| H-T5 | XPKG-09-HOST：两种顺序、后一个 session_start 跨 macrotask await、turn 后 widget 更新的真实宿主顺序；描述现有尽力排序，不能据一次同步成功声称任意异步顺序保证 |

每项保存：时间、host 版本、两仓 revision、隔离配置与启动命令、动作、预期/实际、终端输出或必要截图、退出/清理情况。为避免隐藏症状，fake 不能替换被观察的宿主生命周期或 footer 管理。失败时先缩小复现，再在本仓授权范围修复；涉及新跨包行为时记录明确差异与依赖。

H-T5 由 TUI 采集证据并记录，core agent据此更新自己的 XPKG-09-HOST 表/todo；TUI 不跨仓修改。原有其他两个 core host todo 不因这项通过而自动关闭。确实缺少可用终端/宿主/模型能力时记录尝试和具体条件，未完成保持 open。

## 5. D4 删除后的兼容回归与观察项

core 用户决策为 D3=A / D4=B / D6=B。TUI 当前不依赖 readCoreStatus；无需因删除再实现一个替代 reader。core C2 删除完成后，对其固定 revision 重跑本仓门禁与现有联合 suite，并确认生产导入仍不使用 runtime reader。C2 未就绪时先做 U-F1、J-USAGE 和不依赖删除的终端项，最后再检查一次上游。

用户补充的 `pi-proto-adapter` 跨模块实例 reload 所有权观察项按预存问题单列：当前 apply 可刷新 incumbent 的 getter，而本实例未必获得 wrapper ownership；本轮未重新证明其在真实 reload 的可达时序。另批先构造多实例 apply/restore 与第三方接管序列、核实宿主 unload/load 次序，再写专门修复规格。本批不据观察项直接更改 patch 协议；若 H-TUI 实际命中，保留独立复现并如实报告受影响验收。

## 6. 自查与完成定义

每个修改批次保留基线红因和实际入口回归，通过 npm test/typecheck 后独立只读审查，修复后复核。若 statusline 脚本本身变化，同步内联副本并按仓库运行性能检查。只修改 TUI；原 6 份规格和索引同步真实状态，不把可选项补做当成本批完成条件。

本批实现完成要求 U-F1 关闭；自动化验收要求 J-USAGE 与 D4 后回归有具体 revision / 非 skip 结果；真实验收 H-T1–H-T5 各自 PASS 或明确 OPEN/FAIL，不能互相替代。交付本地提交和验收记录，发布另行安排。


## 7. 本轮规格复核记录

2026-10-08 独立只读复核通过：U-F1 已由复核者用当前真实函数再次复现，修复规则正确；J-USAGE 的现有覆盖与新增要求区分清楚，原已完成任务没有重复派发。完整结论见 [core 配对复核记录](../../pi-claude-code-core/spec/2026-10-08-followup-execution.md#6-本轮规格复核记录)。此结论不表示本批修复或真实终端验收已经执行。

## 8. 执行记录（本仓 agent，2026-10-08）

### U-F1 已关闭

- 红基线：U-F1a（helper 精确输入）与 U-F1b（session 渲染 + JSON）先红（contextWindow 返回 1M）后绿；U-F1c 组合表同步钉住。
- 修复：`selectDisplayUsage` 的 ctx 选择改为整组结果 `{usedPercent, usedTokens, contextWindow}`——core percent → core tokens → tracker+hostWindow 整组回退（coreWindow 不再混入第三分支的分母）；cost/累计独立口径不变，真实零保持。
- 验证：npm test 275 passed / 0 skipped（基线 272 + U-F1a/b/c），typecheck 退出 0。
- 独立只读审查：ACCEPT（审查者用 git show HEAD 旧版实证先红后绿；MINOR=U-F1b 补 cumulative-only→complete-ctx 同 session 切换断言，已补入）。
- 文档：CHANGELOG（含 710c9c7/1bf9b7f 漏记的 step 2 条目）、双语 ARCHITECTURE 模块表已同步。

### J-USAGE 已落地（自动化验收）

- 新增 `test/modes-producer.joint.test.ts`（J1/J2/J3）：jiti 加载真实 core `extensions/modes/index.ts` 生产者，经可控宿主 adapter 驱动真实 `session_start / turn_start / message_update / before_provider_request / message_end` 事件，production `refreshWorkingMessage → sanitizeUsageNumbers → publishCapability → 真实 bus publish`；TUI 侧为**本仓真实 entry factory**（core-bus client adapters → ReplicaSession.onBusSnapshot → refreshStatusline），非手工 `bus.publish({usage})`。
- 覆盖：core-first（J1，状态行右侧组 + 经 `cat` 真实脚本协议回传的 statusline JSON）、tui-first + 晚 publish（J2，tracker 基数 → core 基数切换，含 statusline off 后右组回持有）、生产清空/真实零/缺失 ctx（J3，session_start 与 session_tree 的 usage:null 清空〔清空后换 tracker 基数以判别〕、0%/0 tokens、null-ctx 经 before_provider_request 强制重读后的整组回退含 U-F1 断言）。旧 core legacy 字符串通道的降级由既有 `cc-status-line.test.ts`/`replica-session.test.ts`（structured=null 路径）与 `pm-capability.test.ts` 覆盖，不在本 fixture 重复。
- 脚本协议走真实子进程（prefs command=`cat`，250ms debounce + spawn），断言解析回传 JSON；行断言遵守已钉住的显示规则（脚本行有输出时右组塌缩、used=0 无括号）。
- 隔离：PI_CODING_AGENT_DIR/claude-tui.json/prefs、core `setConfigPath`/`setModelsPath`/`setAgentDirForTests` 全部指向临时目录，结束恢复原值；globals 清理。
- 验证：npm test 278 passed / 0 skipped（含本 suite 3 例实际执行），typecheck 退出 0；joint 文件连续 3 次复跑全绿。编写时 sibling 生产代码为 `2ebd226`；suite 不在内部硬钉 revision（core 合法前进会破坏硬钉），改由 `CC_TUI_JOINT_CORE_ROOT` 环境变量支持指向固定 revision 的干净 worktree 运行——D4 后回归即以此方式对 `ff81050` 执行（见 §9）。sibling 缺席机器保持 skip 语义（`CORE_AVAILABLE`），与本机实际执行不冲突。本批 TUI revision：U-F1 批 `f609b9b`。

## 9. D4（core C2 runtime reader 删除）后回归 — PASS

- core 于 `ff81050` 落地 D4=B（`feat(types)!`：撤除 `./types` runtime reader，subpath 仅 type-only）。本仓以 `git archive ff81050 | tar -x` 完整快照（对 core 工作树/.git 零写入，其时 core 工作树另有 C3 进行中改动，不可直接引用）+ `CC_TUI_JOINT_CORE_ROOT` 指向快照重跑全部门禁：**npm test 278 passed / 0 skipped、typecheck 退出 0**（两份联合 suite 均在快照上实际执行）。
- 生产导入核查：本仓 `extensions/`、`scripts/` 无 `readCoreStatus` / `pi-claude-code-core/types` / core-status 引用（grep 空）；TUI 直接读 bus 快照，无需替代 reader，未新增。
- **快照路径坑（已验证并记录）**：快照若放在 `/tmp`（macOS 上为 `/private/tmp` 的 symlink），jiti 对相对导入做 realpath 归一后同一 `bus.ts` 会注册成两个模块实例——`resetCoreBusForTests` 只重置其一，C1/C3/C4 出现假红（双 singleton 双显示）。快照须放在非 symlink 路径（本轮用 `Pi-Extension/.tmp/core-d4-ff81050`，跑完已删；node_modules 可 symlink）。复现：`git -C pi-claude-code-core archive ff81050 | tar -x -C <real-path>` 后 `CC_TUI_JOINT_CORE_ROOT=<real-path> npm test`。
- sibling 当前 HEAD 的脏工作树（C3 进行中）同轮亦绿；正式证据以固定 revision 快照为准。

### H-T1–H-T5 已执行（真实终端/宿主证据，2026-10-08）

完整台账与逐项日志/可见屏快照：[docs/evidence/2026-10-08-host/LEDGER.md](../docs/evidence/2026-10-08-host/LEDGER.md)。host=pi 1.0.2；TUI=`632d4e8`（`-e` 直载本仓 entry）；core=`ff81050`（git archive 固定快照，sibling 当时 C3 进行中）；隔离 `PI_CODING_AGENT_DIR`+项目 git 仓；PTY 驱动=stdlib pty + pyte 屏幕仿真（raw log + 毫秒级快照）；模型回合用本地复制的凭据（跑完即删，不落日志）。

- **H-T1 PASS**：print 无 tip、session 无 packed entry；/reload 告警可重复；off→on 槽位往返、tip 仅一次；慢脚本 in-flight 退出零残留。跨包发现：core effort 告警自身双显（DC3 dual-write，有无 cctui 均 2 次）——core 侧问题，本仓仅记录。
- **H-T2 PASS**：propose_goal_draft 通用摘要行 / get_goal JSON 回退行 / session_recall 命名行 / obs_recall 假 id 错误原文行 / 本地 stdio MCP 的 `dummy - echo_search (MCP)` 行（宿主事实：`--no-extensions` 连带禁用 MCP 注册）。manual 旧工具名（goal_question/apply_goal_tweak）在 core ff81050 不存在，清单已按实名更新。
- **H-T3 PASS**：脚本行持数（右组塌缩）/ statusline off 右组持有（真实 turn `Ctx 1%(10k/1.0M)│$0.0008`）/ native footer 无重复 / 运行中结构化 ↑↓⚡ / 真实零 `Ctx 0% (0/1M)` / 持久错误行+自愈。发现：manual 的「set false-cmd 三次」配方达不到 3 连败阈值（每次 set 重建 runner 清零计数），需 set 一次+真实 turn 刷新；manual 已注记。
- **H-T4 PASS（经济降级行 OPEN）**：双顺序告警/reload；off/on+native footer；reload 后 TUI 载入失败会话存活、core 自持显示（ht4e）；启动期破损则 pi 整体退出（宿主行为差异，已记）。降级行无法触发：probePiCompat 仅按 `pi<0.87` 门控且无覆盖入口，恢复条件=旧宿主重跑；渲染路径由 C6+表测覆盖。
- **H-T5 PASS（尽力语义如实描述）**：双顺序下 goal 块在上、cc-status spinner 紧贴编辑器；turn 中 goal 块实时更新（token 计数）而 spinner 保持相邻；晚挂载 widget（goal set 于启动后 ~10s）不破坏次序。不据此声称对任意异步扩展的排序保证。

XPKG-09-HOST 证据由本仓产出（上表+台账），core 任务据此回填其契约/todo；本仓未跨仓改动。


## 10. 同日跟进批执行记录（第二会话，core 固定联验 revision `e98ce4a` + TUI `d846302`）

用户派发的收口批次：修复 core effort 通知双写（core `25c38b2`）、C5 全四步（core
`828c5c6→4b0f8d9`）、H-Q 证据复审重跑（core `af924a6`）之后的 TUI 侧补验收。证据
台账（含逐屏快照与 raw log）：[LEDGER 跟进批](../docs/evidence/2026-10-08-host/LEDGER.md)。

### H-T1–H-T5 子场景定级（证据等级：T=真实终端 PTY；P=真实宿主非终端；F=factory fixture；U=纯函数）

| 子场景 | 级别 | 结论 | 证据 |
|---|---|---|---|
| H-T1 print 无 tip/无 packed entry | P | PASS | run/ht1（首批） |
| H-T1 /reload 往返（可重复告警） | T | PASS | run/ht1（首批）+ ht4r-a/b/c（跟进批：修复后恰一次） |
| H-T1 off→on 生命周期 | T | PASS | run/ht1（首批） |
| H-T1 退出终止 statusline 子进程 | T | PASS | run/ht1d（首批） |
| H-T2 通用 schema 行 / get_goal JSON 回退 | T | PASS | run/ht2b（首批） |
| H-T2 goal_question（/goal-tweak 访谈内） | T | **PASS（跟进批纠正）** | run/ht2g 95s 屏——首批「工具不存在」为错误结论 |
| H-T2 apply_goal_tweak（tweak 应用） | T | **PASS（跟进批纠正）** | run/ht2g 245s 屏（⏺ 行 + ⎿ Goal tweak applied） |
| H-T2 obs_recall 错误原文 | T | PASS | run/ht2（首批）+ ht2i（跟进批复验） |
| H-T2 obs_recall 真实多页 + 分页头 | T | **PASS（跟进批补齐）** | run/ht2i：`⎿ 2.3KB · 398 lines · start→+2.3KB · more ▸`（next_offset/eof） |
| H-T2 MCP 原生形态 | T | PASS | run/ht2f（首批）+ ht2h2（跟进批，pyte 重放屏） |
| H-T2 MCP proxy `mcp{tool}` | T | **PASS（跟进批补齐）** | run/ht2h：`⏺ dummy - echo_search (MCP)(tool=… args=…)`（探针源,已注明） |
| H-T2 MCP env allowlisted direct | T | **PASS（跟进批补齐）** | run/ht2h：`⏺ dummy - echo (MCP)`（PI_CORE_MCP_DIRECT_SERVERS） |
| H-T2 MCP bare `mcp_*` 回退 | T | **PASS（跟进批补齐）** | run/ht2h：无 (MCP) 徽标的通用行 |
| H-T3 脚本行持数/右组塌缩 | T | PASS | run/ht1（首批）+ ht3w2（跟进批） |
| H-T3 off 右组持有 / native footer 无重复 | T | PASS | run/ht3/ht4a（首批） |
| H-T3 等待态（in-flight） | T | **PASS（跟进批补齐）** | run/ht3w：慢脚本窗口内右组持有、无脚本行/错误行 |
| H-T3 持久错误行 + 自愈（含 timeout 变体） | T | PASS | run/ht3c（首批）+ ht3w（timeout）、ht3w 首跑（127 引号坑） |
| H-T3 真实零 | T | PASS | run/ht1（首批） |
| H-T4 双顺序/reload 告警（修复后） | T | **PASS（跟进批复验）** | run/ht4r-a/b/c：每 session_start 恰一次 |
| H-T4 off/on 新告警交接 | T | **PASS（跟进批复验）** | run/ht4r-d：off 态 core fallback 恰一次、on 后再发再显一次 |
| H-T4 reload 后 TUI 载入失败 core 接管 | T | PASS | run/ht4e（首批） |
| H-T4 经济模块降级行 | — | **OPEN** | 见下「仍 OPEN」 |
| H-T5 双加载序 goal 块/spinner 相邻 | T | PASS | run/ht4a/ht4b（首批） |
| H-T5 晚挂载 widget（启动后 10s） | T | PASS | run/ht4a（首批） |
| H-T5 turn 中 goal 块实时更新 | T | PASS | run/ht4a（首批） |
| H-T5 后挂 session_start 跨 macrotask await | T | **PASS（跟进批补齐）** | run/ht5m-*：handlers 顺序执行、widget 按注册完成序；goal/spinner 相邻性双序保持——边界如实描述,非任意异步保证 |

### 仍 OPEN

- **经济模块降级行（H-T4）**：`probePiCompat` 仅按 `pi<0.87.0` 门控；装配层
  （core `extensions/index.ts` economy 块）把真实编译期 VERSION 硬穿进工厂，无
  env/config 覆盖——pi 1.0.2 上无任何生产路径可走降级分支。已尝试：源码核查
  （probe 输入与装配穿线）、宿主能力面（pi 1.0.2 无 exposure=proxy 等 producer）。
  恢复条件（精确）：① 任意 pi<0.87 宿主上的 **core-only** 会话（TUI peer 要求
  pi≥1.0.1,该宿主上 TUI 会话不是有效目标）；② 或 core 侧为 version 输入加测试
  seam（仅为验收加产品开关已被裁定为反模式,未做）。渲染路径由 joint C6 +
  composeFooterLines 表测覆盖（U/F 级）。

### 其他勘误（本批固化）

- 首批 LEDGER/manual 的「goal_question/apply_goal_tweak 在 core 不存在」为错误
  结论（工具为 drafting/tweak 门控）——manual §12 已改写并保留纠正记录。
- 首批「通知一次/两次」矛盾（H-T1b 双显 vs 契约单显）系 core DC3 双写所致,
  core `25c38b2` 修复后本批复验单显——manual §13 已更新。
- macOS `/tmp`→`/private/tmp` 与「mcp.json exposure 默认 codemode 不进模型工具表」
  两个宿主事实已入 LEDGER。
