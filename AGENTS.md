# AGENTS.md — AI 助手仓库指南

面向在本仓库工作的 AI 编码助手（以及新加入的人类贡献者）。读完这一份，你就知道代码长什么样、怎么验证改动、哪些坑已经踩过。

> 架构与模块细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（英文版 [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md)）。English version of this file: [AGENTS.en.md](AGENTS.en.md).

## 这个仓库是什么

`@georgedong32/pi-claude-code-tui` —— 一个 [pi](https://pi.dev) 包，把 pi 的 TUI 复刻成 Claude Code 的观感：CC 风格工具行、启动头、旋转 spinner 动词、可配置 statusline、编辑器与 claude-code 主题。

**一条红线**：本包是纯显示层。**不改任何工具的 `execute`、不改任何发给模型的内容**。工具行覆盖只换 `renderCall` / `renderResult`，执行始终委托给 pi 内置实现。任何改动如果影响了语义（而不只是外观），都偏离了本包的定位。

## 常用命令

```bash
npm test            # node --test test/*.test.ts —— 无需构建，TS 直接跑（type stripping）
npm run typecheck   # tsc --noEmit
node scripts/bench-statusline.mjs   # statusline 默认脚本性能基准（改动 statusline 后建议跑）
```

没有构建步骤、没有 lint 配置。`npm test` + `npm run typecheck` 双绿是每次提交的底线。

## 目录结构

```
extensions/
  claude-code-tui.ts        # 扩展入口（default export factory）：事件接线、命令、模式开关
  lib/                      # 纯模块（无 pi 运行时依赖，可单测）
    cc-rows.ts              #   CC 工具行渲染器（call/result 行、diff、折叠、component memo、gutter-wrap）
    cc-compaction-row.ts    #   压缩行 prototype patch + 原生压缩指示器静音
    cc-skill-row.ts         #   skill 调用行 prototype patch（CC 式 ⏺ Skill(name)，保留点击展开）
    obs-savings.ts          #   OBS-09 消费端：observation-pack 每站点节省 → 回调（入口 appendEntry 流内伪工具行；dedupe，永不抛）
    cc-markdown.ts          #   markdown transformer：assistant 白字 + user 灰条（纯函数）
    cc-status-line.ts       #   cc-status 行：右侧组（model·effort │ Ctx │ cost）、左右拼接、footer 模式标签
    takeover-rules.ts       #   工具行接管决策矩阵 + resolver 计划层（纯函数，全组合表测；BUILTIN_SEVEN 单一来源）
    run-state.ts            #   run/compaction 状态机（注入 clock/timer，转移可测）
    host-status.ts          #   host 易变状态读取 seam（effort 读取，永不抛）
    claude-tui-editor.ts    #   CC 式编辑器（半开圆角边框、❯ 提示符、块状光标）
    pi-startup-header.ts    #   Pi-look 启动头（动画 logo + tips 侧栏 + header 布局/tips 选取纯函数）
    format.ts               #   纯值格式化（时长/token/cost/模型标签/完成行）
    spinner-verbs.ts        #   spinner 动词表（187 词 CC 对齐 + 加权抽样 + Piing 彩蛋）
    spinner-shimmer.ts      #   spinner 动词流光（CC computeShimmerSegments 移植，纯函数）
    statusline.ts           #   statusline JSON 合成、badge、子进程 runner、footer 组合
    statusline-default-script.ts  # 内置默认脚本的 TS 内联副本（与 scripts/ 字节同步）
    status-snapshot.ts      #   UsageTracker：会话用量快照（每事件重算，供每帧读缓存）
    pm-capability.ts        #   permission-modes 能力通道消费端 + 核心通知队列消费（activate/withdraw 配对）
    prefs.ts                #   ~/.pi/agent/claude-tui.json 读改写（原子）
themes/claude-code.json     # claude-code 主题（vars/colors）
scripts/statusline-default.sh   # 默认 statusline 脚本（source of truth，与 TS 内联副本字节同步）
scripts/bench-statusline.mjs    # statusline 性能基准
test/                       # node --test；golden test + 纯模块单测
docs/                       # 架构文档、人工验证清单、历史设计文档
src/                        # 空目录残留（无文件，勿引用）
```

## 代码约定

- **TypeScript ESM，直接运行**：pi 用 jiti 加载 TS，无编译产物。相对导入**必须带 `.ts` 扩展名**（如 `./lib/prefs.ts`）。
- **缩进用 tab**（现有代码一致）。
- **纯模块优先**：凡是可以脱离 pi 运行时测的逻辑（渲染器、格式化、JSON 合成、prefs IO），都放 `lib/` 并保持可注入依赖（theme 鸭子类型、注入 RNG/path）。入口文件只做接线。
- **渲染器字节级稳定**：`lib/cc-rows.ts` 的输出被 `test/cc-rows.golden.test.ts` 逐字节钉死。改渲染输出必须显式更新 golden 文件并在提交信息里说明视觉差异。
- **鸭子类型镜像 pi 内部类型**：不要 import pi 未导出的类型；按本仓库惯例在 `lib/` 里写 `XxxLike` 镜像接口 + 版本号门控（参考 `pm-capability.ts`）。
- 依赖版本：devDependencies 钉在当前 pi 版本（`1.0.x`），peerDependency 是 `>=1.0.1`（工具行依赖 `pi.registerToolRenderer`，1.0.1 才有）。pi 升级带来的适配改动用 scope `1.0-adapt` 之类标注。

## 提交与发布

- Conventional Commits：`feat(rows): …`、`fix(status): …`、`chore(release): 1.5.0`。scope 常用：`rows`、`tui`、`status`、`statusline`、`1.0-adapt`。
- 发布流程（git-first）：改 `package.json` version → 更新 `CHANGELOG.md` → `chore(release): vX.Y.Z` → `git tag vX.Y.Z` → push。本机安装为 pi 的 git 安装形态（`git:github.com:GeorgeDong32/pi-claude-code-tui`），安装目录 `git pull` 后 `/reload` 即生效——**npm publish 不是必经步骤**（README 的安装引导也是 `pi install git:…`；如需同步发 npm，本机无官方 registry 凭据，须由用户本人 `npm login` 后执行）。`package-lock.json` 与 `AGENTS.md` 曾在 .gitignore；AGENTS.md 现已入库。

## 编写 / 修改扩展时的注意事项（踩过的坑）

这些不是风格建议，是**会导致 pi 崩溃或行为回退的真实约束**：

1. **`render()` / `updateDisplay()` 里绝不能抛异常**。渲染回调在 pi 无法捕获的调用栈里执行，抛了整个 pi 直接挂。所有容错（prefs 读失败、脚本失败、主题缺失）都吞掉并降级。
2. **渲染热路径上不要 spawn、不要全量重扫**。每帧被调用的 render 只读缓存：会话用量靠 `UsageTracker`（`message_end` 时重算一次），statusline 是事件驱动 + 250ms debounce + in-flight 合并，每帧最多触发一次宽度变化检测。
3. **`ctx` / `ctx.ui.theme` 会过期**。session 替换或 `/reload` 后旧 ctx 失效。不要在 enable 时捕获 theme 存闭包长期用；要么每帧从当前 ctx 取，要么像 `cc-compaction-row.ts` 那样传 `getFg()` 惰性读取。启动头（`pi-startup-header.ts`）也不例外：render 只能读入口注入的 getter 和 `setHeader` 工厂参数里的 theme，不能访问 ctx。
4. **prototype patch 必须幂等**。用 `__ccCompact` 这类标记防重复 patch；jiti `moduleCache: false` 会造成同一类有多个模块实例，深路径 import 补丁可能打在没人用的实例上（压缩指示器因此改成实例级 render 覆盖 + 组件树搜索）。现存的 patch 只剩压缩行 / skill 行 / 用户消息条——工具行已改走官方 `pi.registerToolRenderer` 通道（1.8.0 起），不再依赖 patch。
5. **工具行走官方渲染器通道（pi ≥ 1.0.1）**：`pi.registerToolRenderer` 的 resolver 只能在加载段注册、逐组件构造求值；让路必须原样返回 `next()`（吞掉会剥夺内置/他人渲染器）。头图、编辑器仍是单占位槽、后写者胜。与其他 TUI 扩展共存的策略是 auto 让路（`pi.getAllTools()` 源元数据探测——`next()` 无法区分内置渲染器与他人注册）+ `/claude-tools on` 强制接管 + `FORCE_RESULT_EXEMPT`（pi-subagents 的 live 卡等不折叠）。
6. **加载顺序不可假设**。本包可能在 core / 其他扩展之前加载，`enable` 时探测不到后加载者。所有探测点都要有重试：`readPmStatus()` 每次调用幂等重试订阅核心总线，会话事件里再补一次。
7. **运行时没有文件锚点**。jiti 以 data: URL 求值扩展文件，`import.meta.url` 不指向安装目录。需要文件内容的东西（默认 statusline 脚本）必须内联成 TS 字符串，且与 `scripts/statusline-default.sh` **字节级同步**（`test/statusline.test.ts` 校验）——改脚本两处一起改，或跑同步测试看红。
8. **`keyText()` 在无 host 测试环境返回 `""`**。所有展开提示都要有字面量 fallback（如 `"ctrl+o"`）。
9. **prefs 是共享文件**：`~/.pi/agent/claude-tui.json` 同时存 `toolRows` 和 `statusLine`。写入必须走 `savePrefs()` 的 read-modify-write + tmp/rename 原子替换，禁止整文件覆盖（历史上互相清过对方的键）。
10. **裸 ANSI 处理**：涉及宽度计算时用 `visibleWidth` / `truncateToWidth`（pi-tui），自己写正则剥 ANSI 时记得 APC 序列（`stripAnsi` 的第二个 replace）。
11. **定时器都要 `unref()`**，blink 定时器只在编辑器 focused 时翻转，非强制 `requestRender()`（保住 pi 的行 diff 缓存）。
12. **环境开关**：`CC_TUI_TOOL_ROWS=0`（强制关工具行）、`PERMISSION_MODES_INHERITED_MODE`（旧模式通道 fallback）、statusline 子进程环境里的 `OVERRIDE_TERM_WIDTH`。不要挪用这些名字。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 用户手册：安装、命令、兼容性、故障排查 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构：模块地图、数据流、渲染接管机制、statusline 协议 |
| [docs/manual-verification.md](docs/manual-verification.md) | 视觉效果人工验证清单（自动化测不到的渲染行为） |
| [docs/STATUSLINE-PLAN.md](docs/STATUSLINE-PLAN.md) | statusline 历史设计文档（SL1–SL5 已全部落地，仅存档） |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史 |

## 已知仓库卫生问题

- `src/` 只含空目录，无任何文件——历史残留，不要在里面放代码，也不要 import 它。
