# P0 调用行记录 — subagent 工具行（fork surface-tuning @ 0ebb9c83）

来源：安装副本 `src/extension/index.ts` renderCall（:969）+ `src/tui/render.ts`。CC adapter 的调用行在 P3 经官方 `pi.registerToolRenderer` 通道消费同样数据；本记录是当前 fork 的外观事实。

## renderCall 模板（title = `theme.fg("toolTitle", theme.bold("subagent"))`，gap = `mainWindowRenderer.horizontalSpacing ?? 1` 个空格）

| 分支 | 模板 | 备注 |
| --- | --- | --- |
| `args.action`（控制行） | `title␣{action}␣{dim: agent 或 id前8}` | status/stop 等控制行不再裸关键词 |
| `args.workflow === true/"true"`（reply block） | `title␣{accent: "workflow (reply block)"}{warning: [async]?}{dim: preflight?}` | 保持上游形态（脚本已在上方回复块可见） |
| `args.workflow` 为脚本路径（本地） | `title␣{accent: manifest.head}␣{manifest.body}{warning: [async]?}{dim: preflight?}` | manifest 由 `workflowLaneKeys` 扫描 runs.all/runs.run 字面量得 {key,agent,task}；缓存 32 条（hit 500ms/miss 5s）；远程 machine 启动跳过文件读 |
| `args.label` 非空 | `title␣{label}{dim: [async]?}` | **label 即整条标题**（CC UI.tsx:411 对齐），无 agent 名、无 task 摘要 |
| 默认 | `title␣{accent: agent|"?"}␣{dim: model?}␣{dim: [async]?}␣{task≤60字符,57+…}` | humanized 默认行 |

## label 数据通道（B 类，模型契约）

- schema：`label` 可选 string（3-5 词 UI 标题）；description 各装配形态注入 `SUBAGENT_LABEL_GUIDANCE`（安全指引仍居末）。
- 前台：`subagent-executor` stash label，无 label 时 task 摘要回退（空白化、`/(?:\/[\w@.-]+){3,}/` 路径缩略为 `…/末段`、≤20 字符）。
- 后台：`async-job-tracker` 的 `rememberDispatchLabel`（父侧内存 stash；runner 事件/磁盘摘要按 containment 不含 task 文本）；job 完成时清条目。

## 本仓库对接现状（P3 输入）

本仓库 `takeover-rules.ts` 已含 pi-subagents 工具的让路/接管矩阵（auto 让路 + `/claude-tools on` 强制 + `FORCE_RESULT_EXEMPT` live 卡豁免）。P3 的 CC subagent 调用行 adapter 落在 `cc-subagent-rows.ts`（spec §6），消费上述同源数据；B 类 label 通道保持上游所有，不在本仓库复制。
