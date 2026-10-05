# P0 fork diff 盘点 — `8983754b..0ebb9c83`

spec §11 P0 交付。范围：安装副本（v0.75.0 @ `0ebb9c83`）相对上游基线 `8983754b` 的 **net** 差异：19 提交、21 文件、+816/−157。历史里另有 cherry-pick `d77be232`（上游 #2634）已被上游同步抵消，不计入。

四分类（spec P0 出口术语）：**视觉**（P5 迁移进 CC adapter 后从 fork 删除）、**模型契约**（模型可见内容，独立决策，不随视觉自动迁移）、**控制行为**（非视觉定制，留 fork 记清单）、**接口适配**（展示数据源/装配，服务视觉）。

## A. 视觉 — P5 迁移目标

| 文件 | Δ | 内容 |
| --- | --- | --- |
| `src/tui/fleet-status.ts` | ±129 | CC-parity Fleet roster：单标记列（选择箭头原位替换圆点，不另占列）、整树单行骨架、顶层与 main 对齐、树分支与圆点间距、嵌套行 token 花费、workflow phase 可读行、roster 激活门、折叠分支删除、完成行嵌到 ⎿ 结果槽 |
| `src/tui/render.ts` | ±26 | CC-parity 调用行（⏺ 外观、label 优先标题、agent+model(dim)+[async](dim)+task 摘要默认行、status/控制行 target 显示、workflow manifest 头/体渲染、reply-block 保持上游行） |
| `src/workflows/workflow-checklist.ts` | ±20 | `FALLBACK_PHASE_LABEL="Tasks"`（替代误导性 "Workflow"）、phase 计数 `· ` 分隔、checklist 摘要格式 |
| `src/extension/index.ts`（733 段） | ~49 | 工具 renderer 内的调用行渲染分支（消费 A/D/B 数据） |
| `test/unit/fleet-status.test.ts` | ±238 | 上述视觉的契约测试（选择列稳定、单行骨架、嵌套 token、phase 行、完成嵌套） |
| `test/unit/run-status.test.ts`、`workflow-chat-progress.test.ts`、`workflow-checklist.test.ts` | ±6 | 随视觉/文案更新的断言 |

## B. 模型契约 — label 通道（独立决策，不随 P5 自动迁移）

| 文件 | Δ | 内容 |
| --- | --- | --- |
| `src/extension/schemas.ts` | +5 | 工具 schema 增加 `label` 可选字段（模型可写） |
| `src/extension/tool-description.ts` | ±11 | `SUBAGENT_LABEL_GUIDANCE` 注入各 description 装配形态（安全指引仍居末） |
| `src/shared/types.ts` | +2 | `label?: string`（父侧 UI stash，不持久化） |
| `src/runs/background/async-execution.ts` | +4 | label 透传 |
| `src/runs/background/async-job-tracker.ts` | +13 | `rememberDispatchLabel` 父侧 stash（runner 事件/磁盘摘要按 containment 设计不含 task 文本） |
| `src/runs/foreground/subagent-executor.ts` | +13 | 前台路径 label stash + task 摘要回退（≤20 字符、路径缩略） |
| `test/unit/schemas.test.ts`、`tool-description.test.ts` | ±34 | label 契约测试 |

P5 处置选项：留 fork（清单记录）或整理为上游 PR。**删除会让 CC 调用行失去 label 来源，禁止顺手删。**

## C. 控制行为 — 留 fork，清单记录

| 文件 | Δ | 内容 |
| --- | --- | --- |
| `src/slash/slash-commands.ts` | +18 | `/subagents-*` 白名单 Proxy（仅 run/subagents-stop/subagents-steer/subagents-detach 注册；状态查询走工具 action:"status"；理由：workflow-scripts 禁用时 run 是唯一直发入口，上游 #2596） |
| `src/watchdog/register-main.ts` | +13 | 抑制 `/subagents-watchdog` 命令（watchdog 本体默认关、保留） |

## D. 接口适配 — 展示数据源（服务 A，P5 与 seam 一并决策）

| 文件 | Δ | 内容 |
| --- | --- | --- |
| `src/extension/index.ts`（154/163 段） | ~251 | `workflowLaneKeys`：dispatch 期 JS 字面量扫描（runs.all/runs.run 的 {key,agent,task}）；workflow manifest 缓存（32 条、hit 500ms/miss 5s TTL）；path-form workflow 的 CC 式 manifest 头/体 |
| `src/extension/index.ts`（-79 段） | ~1 | import 调整 |

注意：D 是"上游为展示提供 label/摘要"的 fork 实现。spec §3 责任表把 row identity/label 归 pi-subagents 展示 module，P1 seam frame 应承载等价信息；届时 D 或转为 seam 数据源保留在 fork，或被 seam 原生能力替代——P5 按实际 seam 形态定，不提前删。

## E. 过程文档 — 留 fork

`CHANGELOG.md`(+5)、`SPEC-baseline-failures-2026-10-04.txt`(+22)、`SPEC-upstream-sync.md`(+133)。

## 提交级视图（19 条）

`57ad7645` CC-parity call rows/labels/fleet roster（A+B+D 起点）→ `9c50443e`/`ff767fed`/`b2f8f571`/`7f7fe7f6` 视觉修正（A）→ `0c4d03f7` 测试（A）→ `d480e353`…`9157ac43` roster/选择列系列（A）→ `9c2a000a` merge upstream + `d77be232` cherry-pick（已抵消）→ `018e63a1` 上游同步适配（A+B+D+C）→ `891d8154` 测试钉死（A）→ `0ebb9c83` 文档（E）。
