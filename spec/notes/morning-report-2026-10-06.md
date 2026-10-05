# 晨报 — subagent 展示解耦 goal（2026-10-06 早）

睡前指令已完成：推送 ✓ → fork 清理（P5）✓ → 额外完成 P6 文档 + 上游更新演练。两仓库工作区干净、已推送、测试全绿。

## 已推送

| 仓库 | 分支 | 范围 |
| --- | --- | --- |
| GeorgeDong32/pi-claude-code-tui | `main`（8581453..3e77e35，8 提交） | P0 基线/夹具、P2 CC 纯绘制+协议镜像、P3 bridge、§8.1–8.4、P6 文档 |
| GeorgeDong32/pi-subagents | `presentation-seam`（0ebb9c8..b0332ba，5 提交） | P1 seam（协议+注册表+投影+接线）、P5 fork 视觉回退、演练记录 |

## P5 做了什么（fork 清理）

- **native adapter 回归上游形态**：非交互=折叠摘要行（"N active agent · usage · ↓/← to inspect"），交互=帮助行+展开树+完整 token 格式。与 8983754b 原渲染器字节级等价（44/44 原测试 + 双实现同状态对比）。
- **删除**：renderCall CC 分支、workflowLaneKeys/manifest（D 类）、render.ts 结果行 CC 化。
- **保留**（清单在 fork 的 `SPEC-fork-diff-after-p5.md`）：label 通道（B，模型契约）、`/subagents-*` 白名单（C）、**checklist 措辞**（"Tasks"/"· running"）——因为 `formatWorkflowChecklistText` 被 run-status/async-status 的**模型可见 content 路径**复用（spec §11 非视觉类）。这是 native 与 8983754b 的唯一保留差异。
- **验证**：全量测试失败集与 0ebb9c83 基线完全一致（已知环境项，零新增）。

## P6 演练（已记录）

`8983754b→6826b054`（15 提交）合并：仅 CHANGELOG 平凡冲突，typecheck/测试零新增失败，**CC adapter 零修改**（seam 达标判据成立）。演练分支已删。

## 早上验证步骤（P4 人工验收）

1. 安装目录更新：
   - `cd ~/.pi/agent/git/github.com/GeorgeDong32/pi-claude-code-tui && git pull`
   - `cd ~/.pi/agent/git/github.com/GeorgeDong32/pi-subagents && git fetch && git switch presentation-seam`（该分支含你未推送的 93 提交之上的 5 个新提交）
2. 重启 pi（或 `/reload` 两个扩展）。
3. 跑一个 subagent，按 `docs/manual-verification.md` §10 清单过一遍（要点：底栏外观应与之前**完全一致**（CC adapter 字节级等价）；console 不应出现 `[claude-tui] subagent fleet drawing fell back to native`）。
4. `/claude-tui off` → 底栏变原生折叠行；再开 → 恢复。

## 已知的行为变化（需要你决策/知悉）

1. **subagent 调用行（auto 模式）**：fork 的 renderCall 已回退上游形态；CC-TUI auto 检测到 pi-subagents 自带渲染器会让路 → auto 模式下 subagent 调用行变上游样式（`subagent reviewer` 无 label 标题）。`/claude-tools on` 强制模式则用 CC-TUI 的 `subagentCallSummary`（label 标题、agent+task 摘要）。**选项**：a) 接受（spec §6.1 保留现有决策）；b) 我把 takeover 规则改为"seam 激活时 subagent 工具行也强制 CC"。
2. **结果完成行**：fork render.ts 回退后，让路模式下 subagent 完成行是上游平铺样式（不再 ⎿ 槽嵌套、运行中不再是零行）。force 模式不受影响。
3. **checklist 措辞**保持 fork 味（"Tasks · running"）——deliberate（模型路径复用）。

## 剩余工作（goal 未完）

- **async surface seam**（spec §4.4 双 surface 的另一半）：`render.ts` 的 `subagent-async` widget 是交互式组件（展开态/鼠标/动画），frame 投影设计较大——**刻意留到与你一起做**，深夜赶工有破坏 async 可见性的风险。
- P4 人工验收（上节）。
- P6 收尾：发布说明列验证组合（现在就可以写：pi 1.0.2 + presentation-seam ≥ b0332ba + CC-TUI ≥ 3e77e35）。
