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
