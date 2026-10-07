# TUI 后续修复与验收 Prompt

将以下正文交给在 pi-claude-code-tui 工作的 agent。

```text
继续自主完成 TUI 后续修复与验收。工作目录：
/Users/gd32/Coding/Pi-Extension/pi-claude-code-tui

先读 AGENTS.md、spec/README.md、spec/2026-10-08-followup-validation.md 及其引用规格、docs/manual-verification.md，并只读配对 core/spec/2026-10-08-followup-execution.md。

先检查 HEAD 和工作区：TUI 1bf9b7f 已完成原 6 份规格必做实现，包括 710c9c7 的 usage 第二步与 1bf9b7f 的缺失 ctx 修复。不要照旧索引重复实施。core 起始核对版本为 2ebd226，instance/footer/usage 已就绪。保留用户改动与可能尚未提交的新规格；切 worktree 时带入最新文档。

本轮任务：
1. U-F1：修 selectDisplayUsage 的窗口混源。tracker.used=50k、hostWindow=200k、core 仅有 window=1M 时，当前真实输出为25%(50k/1.0M)；应按选定 tracker 来源返回25%、50k、200k。只补此缺陷，保持 cost/累计口径与真实零。验证实际状态行和 session 生成的 statusline JSON，不只测 helper。
2. J-USAGE：补真实 core modes 事件生产→bus→实际 TUI 接线/显示/JSON 的联合 fixture。现有 C7-usage 真实 bus+手工 payload 保留，它不能替代生产事件验证。覆盖双加载顺序、晚 publish、new/reload、0/缺失和回退；联合 suite 必须实际执行而非 skip。
3. H-T1–H-T5：按后续规格和 manual-verification §11/12/12.5/13，使用隔离配置和现有真实终端/PTY能力执行生命周期、工具行、用量、footer/通知/reload失败、宿主widget顺序取证。记录 host版本、双方revision、启动参数、动作及实际证据。真正缺少能力时记录已尝试内容和恢复条件，不能只写“需用户真机”就停止所有工作。
4. core C2 reader删除后，对固定revision重跑TUI门禁/联合测试；未就绪先做其他项，结束前重查一次。用户已选 D3=A、D4=B、D6=B，不存在这些决策的等待；TUI不依赖runtime reader，不新增替代reader。

每批做基线红测试/证据→实现→npm test与npm run typecheck→独立只读subagent检查spec符合、显示兼容和资源释放→修复并复审→本地分批提交。版本控制按仓库与可用技能执行。不支持subagent时明确记录限制并做第二遍自查。不得用删断言、改golden或修改规格掩盖回归；仅在确有授权的视觉变化时更新golden并解释。

只修改TUI，core只读；联合测试使用固定revision或完整快照。XPKG-09-HOST由本仓产出证据，core自行回填其契约/todo。同步中英文架构、CHANGELOG、spec状态和manual-verification。终端/factory fixture/纯函数测试的证据层级分别记录。

effort pin、ANSI合并继续可选置后；pi-proto-adapter跨实例reload观察项保留为另批调查，本轮不直接重写协议，若实际验收触发则记录独立复现。push/tag/发布另行安排。

持续推进所有可执行任务。额度中断时留下绿色revision、具体步骤和下一条操作，不能标称全部完成。最后报告U-F1/J-USAGE/D4后回归/H-T1–H-T5各自状态、提交、测试结果、独立审查、双方revision及剩余恢复条件。
```
