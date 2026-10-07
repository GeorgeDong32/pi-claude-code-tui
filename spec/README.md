# spec/ — TUI 实现规格

2026-10-07 联合审查已拆成 **TUI 6 份 + core 9 份**。本轮完成规格与源码核对，尚未实施代码。配对入口：[core spec 索引](../../pi-claude-code-core/spec/README.md)，[跨仓核对记录](../../pi-claude-code-core/spec/2026-10-07-spec-review.md)。

基线：TUI `7192d9f`（1.9.0）、core `09c2dcb`（0.3.0）、本地 pi 1.0.1。旧行号仅作该基线导航，函数名/实际源码为准；两种加载顺序均在验收范围，用户当前 settings 不是协议前提。

## 规格与前置条件

| 优先级 | spec | 清单项 | 规格状态 / 实施前置 |
|---|---|---|---|
| P0-1 | [生命周期修复](2026-10-07-p0-1-lifecycle-fixes.md) | TUI-03 / 04 / 05 / 06 | 已补齐；含非 TUI、shutdown、header、timer/generation 与 dispose 后 TERM→KILL |
| P0-2 | [core-bus client](2026-10-07-p0-2-core-bus-client.md) | TUI-01 / 02 / 12 / 14 + footer | 已补齐；依赖 P0-1，与 core P1-1 联合验收；支持旧 core |
| P1-1 | [core 工具展示](2026-10-07-p1-1-core-tool-display.md) | TUI-07 | 已补齐；三步可独立提交；core P1-1 先登记相关字段契约 |
| P1-2 | [用量单一展示](2026-10-07-p1-2-usage-single-display.md) | TUI-08 / 10 | 已补齐；第一步可独立，第二步依赖 core P2-4；pin 标记可选 |
| P2-1 | [ReplicaSession](2026-10-07-p2-1-replica-session.md) | TUI-11 | 已补齐；依赖 P0-1/P0-2；渲染 golden 保持 |
| P3-1 | [文档与小问题](2026-10-07-p3-1-docs-and-nits.md) | TUI-09 / 13 / 15 | 已补齐；D3 注释随 P0-2，D5 timer 清理随 P0-1；宿主顺序证据仍需取得 |

TUI-01…15 均有去向。widget macrotask 排序保持尽力行为，不承诺对任意异步扩展恒定排序；core 契约 XPKG-09-HOST 登记证据状态。通知 cap 20 无 ACK、obs 仅最后一批，不写“任何迟到下都绝不丢失”的承诺。显式 off 恢复宿主 stock footer，不自动恢复 core footer，display.footer 届时不显示。

## 实施与验收约定

- 决策来自用户的部分与实现建议分开；core D3/D4/D6 待确认，不阻塞独立 TUI 规格。
- `npm test`、`npm run typecheck` 双绿；bug 基线红→绿，纯搬移靠现有 golden/trace 等价；不因改了测试入口就删除行为断言。
- 渲染只改展示，不改 execute、模型消息、历史 toolResult；display-only CustomEntry 继续沿用既有类型与格式。
- 新 client / lifecycle 通过真实 factory 接线测试与录制 adapter 验证；真机视觉/宿主时序另记结果，未做则 open。
- 代码实施后同步中英 ARCHITECTURE/AGENTS、CHANGELOG、manual-verification；不提前把 spec 状态改为“已实施”。
- 本轮未提交、未发布；未来提交按仓库规则处理，spec 不替代发布授权。

## 既有规格

保留 [2026-10-05 subagent 展示 seam](2026-10-05-cc-tui-subagent-presentation.md) 以及 `fixtures/`、`notes/`、`p0/`。它们不是本次 15 份 spec 的未完成项，不能顺手改写其历史结论。
