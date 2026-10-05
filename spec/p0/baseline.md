# P0 基线记录 — subagent 展示解耦

日期：2026-10-05（重录于 P0 执行时）。本文件是 spec §11 P0 的落地记录，后续阶段以本文固定版本为准。

## 1. 版本快照（实际探测，非 spec 草稿转抄）

| 组件 | 版本 | 提交 | 状态 |
| --- | --- | --- | --- |
| 本仓库 @georgedong32/pi-claude-code-tui | 1.8.0 | `8581453` | 干净；`spec/` 未跟踪 |
| pi 运行时 | 1.0.2 | — | pnpm 全局 `/Users/gd32/Library/pnpm/pi` |
| 已安装 pi-subagents（pi 实际加载） | 0.75.0 | `0ebb9c83` | 分支 `surface-tuning`，工作区干净，领先 `origin/surface-tuning` 93 个未推送提交 |
| pi-subagents 开发 checkout | 0.73.0 | `9157ac4` | `~/Coding/Pi-Extension/pi-subagents`，分支 `surface-tuning`；是安装副本的祖先（过时） |
| 上游 nicobailon/pi-subagents | — | `6826b054`（tip） | 已 fetch；`8983754b` 在其历史中 |
| 本仓库 node_modules pi-tui | 1.0.1 | — | 经 pi 1.0.2 |
| 安装副本 node_modules pi-tui | 0.87.0 | — | **与本仓库不同版本**；夹具/联调须注意模块身份 |

node v24.21.0（原生 type stripping）。

## 2. 谱系拓扑（实测）

```
upstream/main:  … ── 8983754b ────────────── 6826b054 (tip，已前进)
                       ╲ (merge 9c2a000a)
fork surface-tuning:    9157ac4 (=origin/surface-tuning=开发checkout)
                          └──(+93 未推送，含 8983754b 合并与后续)──▶ 0ebb9c83 (安装副本)
```

- `git merge-base 0ebb9c83 8983754b` = `8983754b`（spec 记录的上游基线**核实无误**）。
- net fork diff = `git diff 8983754b..0ebb9c83`：19 提交、21 文件、+816/−157。
- `d77be232`（"Let background subagents start on Pi 1.0.0" #2634，作者 albertgwo、committer 用户本人）是 cherry-pick：上游后来合入原始提交，net diff 中**已抵消**（diffstat 无 runner-aliases.ts）。仅存于历史，不进 P5 清单。
- 上游基线之后 upstream/main 又前进了（tip 6826b054）；P1 seam 开发**基于安装副本状态 0ebb9c83**（当前交互/外观参考），上游同步在 P6 演练，不在 P1–P5 期间追新。

## 3. 固定版本决策（后续阶段的锚）

- **P1 开发基座**：把开发 checkout 同步到 `0ebb9c83`（fast-forward 其 surface-tuning 或新开分支 `presentation-seam` 基于 `0ebb9c83`）。安装副本不直接改；P1 完成后经 push→安装目录 pull→`/reload` 验证。
- **P2/P3 消费基线**：本仓库对 pi-subagents 的形态假设 = `0ebb9c83`（Seam 协议版本 v1 按此实现）；兼容矩阵的“旧版”= 无 seam 的 0.75.0 原生行为。
- **上游更新演练（P6）**：`8983754b → 6826b054`（以及届时 tip）作为演练区间。

## 4. 红线与已知张力（P0 确认）

- fork diff 含**模型契约改动**（`schemas.ts` 的 `label` 字段、`tool-description.ts` 的 SUBAGENT_LABEL_GUIDANCE）：这些改动让模型看到额外 schema 字段与描述指引。它们是 fork 的既有事实，不是本仓库改动；但 P5 清理时**不能顺手删除**（会回退 CC 调用行的 label 来源），需按 spec §11 P5 作为独立决策项（留 fork / 提上游 PR）。见 fork-diff-inventory.md B 类。
- 本仓库红线（不改 execute/schema/prompt/模型可见内容）不受影响：CC adapter 只消费展示 frame。
- 模块身份张力：pi 运行时自带 pi-tui 1.0.1，安装副本 node_modules 有 pi-tui 0.87.0。扩展运行时由 pi 的 jiti 实例解析；spec §5.1 “不依赖 jiti 下单份模块实例”的约束因此**必须**遵守（seam 走 `pi.events`，不走模块 import）。夹具捕获（本仓库脚本读安装副本）须经安装副本路径解析，保证与其测试环境一致。

## 5. P0 夹具与盘点产物

- `spec/p0/fork-diff-inventory.md` — 19 提交/21 文件四分类清单 + P5 处置建议。
- `spec/fixtures/` — Fleet/async/调用行 ANSI 夹具（`capture-fleet-status.mjs` 生成，可重跑）。

## 6. P0 出口清单（spec §11 P0 对照）

- [x] 对齐实际安装与开发基线（§1/§2：实测版本与拓扑，上游基线 8983754b 核实无误；上游 tip 已前进到 6826b054，P1 基座固定为 0ebb9c83）
- [x] fork diff 盘点并逐项分类（fork-diff-inventory.md：A 视觉 / B 模型契约 / C 控制行为 / D 接口适配 / E 过程文档；cherry-pick 抵消项已剔除）
- [x] Fleet 底栏 ANSI 夹具：6 场景 × 2 主题 × 5 宽度 + 选择交互逐步记录（spec/fixtures/fleet/）
- [x] 交互记录（interaction-notes.md：激活门、选择/Enter/Esc、渲染门、行布局、语义色）
- [x] 调用行模板记录（call-row-notes.md：renderCall 四分支 + label 通道 + async surface 结构）
- [x] 本规格视觉要求对照确认：§4.1 图形与 fork 现状一致（●/○ 标记、树分支、token·time 右列、Tasks phase、⎿ 完成嵌套）；差异点待 P2 处理——双向 `↑/↓ N more`（现仅 ↓）、极窄 20 列截断产物含 ANSI reset 噪声、label 优先级链现用 displayLabel→runLabel→workflowKey→description（spec 另有 run label/task 摘要顺序要求）
