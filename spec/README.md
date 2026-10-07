# spec/ — TUI 实现规格

2026-10-08 更新：原 **TUI 6 份 + core 9 份** 中，TUI 必做实现已落地，包括结构化用量第二步；真实宿主/终端验收仍 open。当前新增一个已复现的窗口分母回退缺陷 U-F1，作为后续修复处理，不重做已完成功能。

下一轮从 [用量边界修复与联合验收规格](2026-10-08-followup-validation.md) 和 [TUI 执行 prompt](2026-10-08-execution-prompt.md) 开始。配对 [core 索引](../../pi-claude-code-core/spec/README.md)；历史 [规格核对记录](../../pi-claude-code-core/spec/2026-10-07-spec-review.md)。

当前核对 revision：TUI `1bf9b7f` / core `2ebd226`，宿主依赖 pi 1.0.1。原规格背景定位基线为 TUI `7192d9f` / core `09c2dcb`；不沿用旧行号作为当前函数位置。

## 实施状态

| 优先级 | spec | 清单项 | 当前状态 / 剩余验收 |
|---|---|---|---|
| P0-1 | [生命周期修复](2026-10-07-p0-1-lifecycle-fixes.md) | TUI-03 / 04 / 05 / 06 | 已实施 4282bec + 复审修复；**真实 print/reload/off/on/退出验证已执行（manual §11，evidence ledger）** |
| P0-2 | [core-bus client](2026-10-07-p0-2-core-bus-client.md) | TUI-01 / 02 / 12 / 14 + footer | 已实施 955de27；2a7984f 对新 instance 联测；**真实槽位/通知/reload 验收已执行（§13，经济降级行 OPEN：宿主版本门控）** |
| P1-1 | [core 工具展示](2026-10-07-p1-1-core-tool-display.md) | TUI-07 | 三步已实施 7319c74；**真实 goal/obs/MCP 行验收已执行（§12；多页 obs 头需 populated pack，open）** |
| P1-2 | [用量单一展示](2026-10-07-p1-2-usage-single-display.md) | TUI-08 / 10 | 两步已实施 9accbaa / 710c9c7；1bf9b7f 补缺失 ctx 回退；**U-F1 已修 f609b9b**；J-USAGE 生产事件联合 fixture 已落地（modes-producer.joint）；**终端验收已执行（§12.5；等待态瞬态由表测覆盖）** |
| P2-1 | [ReplicaSession](2026-10-07-p2-1-replica-session.md) | TUI-11 | 已实施 0287b86 + 复审修复，golden 保持；沿用生命周期真实验收 |
| P3-1 | [文档与小问题](2026-10-07-p3-1-docs-and-nits.md) | TUI-09 / 13 / 15 | D1–D7 已实施；**D5 的 XPKG-09-HOST 取证已执行（双顺序+live 更新，尽力语义如实）**；D8 可选未做 |

2026-10-08 本轮执行后基线 npm test 为 **278 passed / 0 skipped**（272 + U-F1 三例 + J-USAGE 三例），typecheck 退出 0。`test/modes-producer.joint.test.ts` 以真实 core modes 生产事件驱动本仓真实 entry 接线（对 core `2ebd226`）；C7-usage 保留为传输/校验层证据。终端验收仍 open。

## 下一轮范围

- U-F1 修复 tracker 回退百分比与 core 窗口混用；J-USAGE 补完整生产事件接线；H-T1–H-T5 完成或明确记录真实验收阻塞；core D4 删除后回归正式消费兼容。
- 用户已确认 core **D3=A / D4=B / D6=B**，没有这些决策的等待；TUI 不依赖 runtime reader，不新增替代 reader。
- 只改展示与已授权生命周期逻辑，不改 execute / 模型消息 / 历史 toolResult。宿主 widget 排序仍是尽力行为，通知 cap 20 与 obs 最后批次的局限保持。
- effort pin、ANSI 合并继续可选置后。pi-proto-adapter 跨实例 reload 所有权按用户补充的预存观察项另批调查，本轮不直接重写协议。
- 每批双门、独立审查、修复与本地提交；同步双语文档/CHANGELOG/manual。实现完成、自动化通过、真实验收通过分开记。现有本地提交已存在，push/tag/发布另行安排。

## 既有规格

保留 [2026-10-05 subagent 展示 seam](2026-10-05-cc-tui-subagent-presentation.md) 及 fixtures/notes/p0；它们不是本次原 15 份规格的遗留实现项，历史结论不随手改写。
