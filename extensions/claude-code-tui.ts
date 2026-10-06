/**
 * Claude Code TUI 复刻扩展（v2 — 全页面复刻）
 * 参考 Claude Code 官方源码 UI（spinnerVerbs / Clawd / BuiltinStatusLine / PromptInput /
 * AssistantToolUseMessage），在 pi 上复刻其 TUI 观感：
 * - 启动头：Clawd 吉祥物 + "Claude Code vX" + 模型名（第三方模型名原样保留）+ cwd
 * - 输入框：CC 式半开圆角边框（只有上下边）+ accent 块状光标（移植自 MIT 的
 *   pi-claude-code-tui 包，见 lib/claude-tui-editor.ts）
 * - 工具行（pi ≥ 1.0.1）：官方渲染器通道 pi.registerToolRenderer —— 单一
 *   resolver 按槽位（call/result/shell）合并 CC 渲染器与 next() 的原渲染器，
 *   内置七件 + 无自带渲染器的第三方/MCP 工具渲染为 CC 风格 `⏺ Tool(args)`
 *   + `⎿  输出`（错误红色、edit 带彩色 diff、read 折叠摘要），renderShell
 *   "self" 去掉背景盒；自带渲染器的第三方工具 auto 让路，显式 on
 *   （/claude-tools on）时接管（subagent / obs_recall 的 result 豁免）。
 *   只换渲染器，execute 与参数从不触碰；旧机制（registerTool 重注册
 *   内置七件 + ToolExecutionComponent 原型补丁）已删，spec
 *   2026-10-03-pi-1.0-tool-renderer-migration
 * - Thinking 折叠：折叠开关本身是 pi 原生设置（hideThinkingBlock / ctrl+t），
 *   本扩展只把折叠标签换成 CC 风格 `✻ Thinking… (ctrl+t to expand)`，
 *   并在用户未做过选择时一次性提示快捷键
 * - Spinner：✻ 花型动画 + Claude 橙 + CC 同款 187 词表（Clauding→Piing 彩蛋）——
 *   每 run 加权抽一个定终身（骨干词高频、彩蛋稀有，CC 本尊是等概率抽样不轮换），
 *   词面有 claudeShimmer 流光扫过 + (esc to interrupt · Ns)
 * - 收尾：✻ Worked for 12s（CC 过去式动词）
 * - 状态栏：模型 │ Context 23% (50k/200k) │ $0.042（/claude-footer 切换；
 *   开原生底栏时自动隐藏，避免与 pi-mcp-adapter / pi-lens 的 footer 重复）
 *
 * Commands:
 *   /claude-tui  — 开/关整套复刻 UI（头 / 输入框 / 转圈 / 状态栏；off 时工具行一并回 stock）
 *   /claude-tools — CC 工具行：on / off / auto（auto 碰到别家自动让路）
 *   /claude-verb — 立即换一个随机动词
 *   /claude-footer — 开/关原生底栏（开：兼容其它扩展 footer；关：CC 极简风）
 */

import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	ccCall,
	ccThenRunCall,
	mcpArgsSummary,
	mcpDisplayName,
	callArgsFor,
	dotStatus,
	thinkingToggleHint,
	type CCTheme,
	ccResult,
} from "./lib/cc-rows.ts";
import { BUILTIN_SEVEN, isBuiltinToolName, planResolverTakeover } from "./lib/takeover-rules.ts";
import { assistantWhiteText, userMessageBar } from "./lib/cc-markdown.ts";
import { buildStatusRightGroup, permissionModeLabel, statusRowLayout } from "./lib/cc-status-line.ts";
import { readEffortLevel } from "./lib/host-status.ts";
import { RunStateMachine } from "./lib/run-state.ts";
import { CodexStyleEditor, cursorOpenFromFgAnsi, setEditorAccentOpen } from "./lib/claude-tui-editor.ts";
import { patchCompactionRow, restoreCompactionRow, silenceNativeCompactionIndicator } from "./lib/cc-compaction-row.ts";
import { patchSkillRow, restoreSkillRow } from "./lib/cc-skill-row.ts";
import { PrototypeMethodAdapter } from "./lib/pi-proto-adapter.ts";
import { weightedVerbSample } from "./lib/spinner-verbs.ts";
import { glimmerIndexAt, shimmerSegments, SPINNER_TICK_MS } from "./lib/spinner-shimmer.ts";
import { UsageTracker } from "./lib/status-snapshot.ts";
import {
	buildStatuslineJson,
	composeFooterLines,
	StatuslineRunner,
} from "./lib/statusline.ts";
import { DEFAULT_STATUSLINE_SCRIPT } from "./lib/statusline-default-script.ts";
import { buildCompletionLine, effortBadgeSymbol, formatDuration } from "./lib/format.ts";
import { drawCcAsyncFrame, drawCcFleetFrame } from "./lib/cc-subagent-rows.ts";
import { SubagentPresentationBridge } from "./lib/subagent-presentation.ts";
import {
	defaultPrefsPath,
	loadPrefs,
	resolveStatusLinePrefs,
	savePrefs,
	type ClaudeTuiPrefs,
} from "./lib/prefs.ts";
import {
	PM_MODE_ENV,
	activateCcTuiChannel,
	startCoreNotificationConsumer,
	readPmStatus,
	withdrawCcTuiCapability,
} from "./lib/pm-capability.ts";
import { applyPiHeaderLook, disposePiHeaderLook } from "./lib/pi-startup-header.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Claude Code palette — "Dark mode (colorblind-friendly)" (theme.ts
// darkDaltonizedTheme): warning rgb(255,204,0), planMode rgb(102,153,153),
// inactive rgb(153,153,153). The brand/accent color is NOT hardcoded — it
// comes from the pi theme's accent token (#8ABEB7 in the bundled
// claude-code theme) via theme.fg, matching the native Pi look. ---
const CLAUDE_DIM = "\x1b[38;2;153;153;153m";
const CLAUDE_WARNING = "\x1b[38;2;255;204;0m";
const CLAUDE_PLAN = "\x1b[38;2;102;153;153m";
const RESET = "\x1b[39m";


const gray = (s: string) => `${CLAUDE_DIM}${s}${RESET}`;
const yellow = (s: string) => `${CLAUDE_WARNING}${s}${RESET}`;

const teal = (s: string) => `${CLAUDE_PLAN}${s}${RESET}`;

// Mode paint for the permission-modes footer chip (module-level: the footer
// closure rebuilt this table on every frame — plan A7). DC1: icon/label come
// from the bus projection (single source, core MODE_META); paint stays a
// cctui asset.
const PM_MODE_PAINT: Record<string, (s: string) => string> = {
	ask: gray,
	plan: teal,
	auto: yellow,
	bypass: (s) => `\x1b[38;2;255;102;102m${s}${RESET}`,
};


// --- Spinner frames (src/components/Spinner/utils.ts getDefaultCharacters) ---
const BLOSSOM = ["·", "✢", "✱", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...BLOSSOM, ...[...BLOSSOM].reverse()];

// Past-tense verbs for turn completion (src/constants/turnCompletionVerbs.ts)
const TURN_COMPLETION_VERBS = [
	"Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked",
];

const randomOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

// --- CC tool rows (`⏺ Tool(args)` + `⎿  output`) ---
// Built-in tool definitions are instantiated via pi's public API and their
// execute is delegated to unchanged; only renderCall/renderResult are
// replaced with Claude Code-style rows, and renderShell "self" drops the
// background box.

// CC tool-row renderers (ccCall/ccResult/dotStatus/callArgsFor/
// textOfResult) live in ./lib/cc-rows.ts — extracted verbatim so they can be
// golden-tested (plan C3). Import them here; behavior is unchanged.

export default function (pi: ExtensionAPI) {
	let enabled = false;
	// --- Tool rows (cards) live on their own switch: the CC `⏺ Tool(args)` +
	// `⎿ output` rows for the 7 built-ins plus the third-party fallback can be
	// turned off independently (`/claude-tools`, or `CC_TUI_TOOL_ROWS=0`), so
	// another TUI extension (e.g. minuque/pi-cc-extensions) can own tool
	// rendering while the rest of the replica (header / editor / spinner /
	// status) stays on. Default on = previous behavior.
	// Preference is tri-state and lives in ~/.pi/agent/claude-tui.json:
	// true/false = explicit user choice (survives /reload and restarts),
	// undefined = auto (no file yet): yield when another extension owns any
	// built-in tool row, checked via pi.getAllTools() source metadata at
	// session_start when every extension has loaded. CC_TUI_TOOL_ROWS=0
	// still forces off (env wins over everything).
	// Plan SL2: the file is a shared read-modify-write store (lib/prefs.ts) —
	// the old saveToolRowsPref serialized {toolRows} alone and would have
	// wiped the statusLine keys (and vice versa).
	const prefsPath = defaultPrefsPath();
	const initialPrefs = loadPrefs(prefsPath);
	const toolRowsPrefOf = (prefs: ClaudeTuiPrefs): boolean | undefined =>
		prefs.toolRows === true || prefs.toolRows === false ? prefs.toolRows : undefined;
	const saveToolRowsPref = (pref: boolean | undefined): void => {
		savePrefs({ toolRows: pref }, prefsPath);
	};
	let toolRowsPref = toolRowsPrefOf(initialPrefs);
	let statusLinePrefs = resolveStatusLinePrefs(initialPrefs.statusLine);
	let toolRowsEnabled = toolRowsPref !== false && process.env.CC_TUI_TOOL_ROWS !== "0";
	let autoYieldNotified = false;
	// Resolver-channel gate (spec DEC-08): true only while the replica is
	// enabled in a TUI session. The renderer resolver is registered at load
	// (pi's loader only accepts registerToolRenderer while loading) and
	// reads this flag per tool-call construction — non-TUI sessions and
	// /claude-tui off yield stock renderers via next().
	let channelActive = false;

	// --- Thinking blocks: CC-style collapsed label + one-time tip ---
	// pi natively collapses thinking blocks behind an italic one-line label
	// (settings.json `hideThinkingBlock`, toggled with ctrl+t and persisted by
	// pi itself). There is no extension API to SET that flag, so the fork
	// stays out of the choice: it only restyles the label to CC's `✻
	// Thinking…` and points at the binding once when the user has never
	// picked a preference.
	const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
	const thinkingPrefExplicit = (): boolean => {
		try {
			if (!existsSync(settingsPath)) return false;
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hideThinkingBlock?: unknown };
			return typeof settings.hideThinkingBlock === "boolean";
		} catch {
			return true; // unreadable settings: stay quiet rather than nag
		}
	};
	let thinkingTipShown = false;
	const applyThinkingLook = (ctx: ExtensionContext) => {
		try {
			ctx.ui.setHiddenThinkingLabel(`✻ Thinking… (${thinkingToggleHint()} to expand)`);
		} catch {
			// stale ctx or older pi without the API — label stays default
		}
		if (!thinkingTipShown && !thinkingPrefExplicit()) {
			thinkingTipShown = true;
			ctx.ui.notify(`Tip: ${thinkingToggleHint()} toggles collapsed thinking blocks (saved to settings.json)`, "info");
		}
	};
	// Who owns the built-in tool rows right now? Returns the owner's source
	// id (e.g. another extension's package), or undefined when pi's own
	// built-ins own them. Same signal minuque/pi-cc-extensions uses to yield.
	const externalToolOwner = (): string | undefined => {
		try {
			const tools = pi.getAllTools();
			for (const name of BUILTIN_SEVEN) {
				const source = tools.find((tool) => tool?.name === name)?.sourceInfo?.source;
				if (typeof source === "string" && source !== "builtin" && !source.includes("claude-code-tui")) return source;
			}
		} catch {
			// getAllTools is unavailable before the extension runtime is bound.
		}
		return undefined;
	};
	// --- Run/compaction state machine (lib/run-state.ts): one owner for the
	// tick timer and every transition; the render below reads view() only. ---
	const runState = new RunStateMachine({
		now: () => Date.now(),
		// Timers must unref() (AGENTS.md trap 11) — the spinner tick is this
		// package's longest-lived interval and must never hold the loop open.
		setTick: (fn, ms) => {
			const h = setInterval(fn, ms);
			h.unref?.();
			return h as never;
		},
		clearTick: (h) => clearInterval(h as ReturnType<typeof setInterval>),
		tickMs: SPINNER_TICK_MS,
		requestRender: () => dockTui?.requestRender(),
		isEnabled: () => enabled,
		pickRunVerb: weightedVerbSample,
		pickCompletionVerb: () => randomOf(TURN_COMPLETION_VERBS),
		completionLine: buildCompletionLine,
	});
	let currentModelName = "";
	let currentProviderName = "";
	let currentContextWindow = 0;

	// --- Editor: flat rules + gold ❯ + blinking bar cursor (CodexStyleEditor,
	// lib/claude-tui-editor.ts) ---
	// (The built-in Plan/Auto mode toggle was removed in the permission-modes
	// integration: pi-permission-modes owns mode state — ask/plan/auto/bypass
	// on Shift+Tab — and this extension's footer renders its published mode.)
	let activeEditor: CodexStyleEditor | null = null;
	let dockTui: { requestRender: (force?: boolean) => void } | null = null;

	const setEditor = (ctx: ExtensionContext) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// NOTE: the factory body runs synchronously inside
			// setEditorComponent (ctx live), but cursorOpen fires on every
			// editor render — it must not touch ctx (stale after session
			// replace/reload → uncaught throw kills pi).
			// Replacing the editor releases the old instance's blink timer
			// (spec 8.1): pi does not do this, and a leaked 530ms interval
			// would keep rendering into a dead TUI.
			activeEditor?.release();
			activeEditor = new CodexStyleEditor(tui, theme, keybindings, () =>
				cursorOpenFromFgAnsi("\x1b[38;2;215;215;215m"),
			);
			return activeEditor;
		});
	};

	// --- CC tool rows via the official renderer channel (pi >= 1.0.1) ---
	// One resolver replaces the two pre-1.0 mechanisms: registerToolOverrides
	// (re-registering the builtin seven with CC renderers) and the
	// ToolExecutionComponent prototype patch. pi consults it per
	// ToolExecutionComponent construction (streaming / execution start /
	// transcript rebuild), passing next() = what the remaining resolvers,
	// the registered tool, then pi's builtin renderer table would use.
	// Merging keeps every slot we don't own at its next() value, so yielding
	// never strips anyone's renderers; execute is never touched (pure
	// display layer). Spec: 2026-10-03-pi-1.0-tool-renderer-migration.
	if (typeof pi.registerToolRenderer !== "function") {
		// Loud guard, no silent optional-chain no-op (spec DEC-02): on pi 0.x
		// the extension still loads (git installs don't enforce peers), so say
		// why the tool rows stay stock. Register-time only, never per render.
		console.warn("[claude-tui] pi >= 1.0.1 required for CC tool rows (registerToolRenderer missing) — tool rows stay stock");
	} else {
		pi.registerToolRenderer((toolName, next) => {
			const orig = next();
			const plan = planResolverTakeover({
				channelActive,
				toolRowsEnabled,
				forced: toolRowsPref === true,
				isMcp: mcpDisplayName(toolName) !== null,
				isBuiltin: isBuiltinToolName(toolName),
				hasOrigCall: Boolean(orig?.renderCall),
				hasOrigResult: Boolean(orig?.renderResult),
				toolName,
			});
			if (!plan) return orig;
			// Call factory — MCP badge / builtin seven / third-party + then_run
			// (TR D2/D3). For non-MCP names without then_run this is
			// byte-identical to the pre-migration ccRenderers builtin branch
			// (spec §3.4 provenance note).
			const callFactory = (args: unknown, theme: unknown, rctx?: { isError?: boolean; isPartial?: boolean }) => {
				const mcpName = mcpDisplayName(toolName);
				const call = ccCall(
					theme as CCTheme,
					mcpName ?? toolName,
					mcpName ? mcpArgsSummary(args) : callArgsFor(toolName, args),
					dotStatus(rctx),
					undefined,
					// CC's userFacingName suffix (`server - tool (MCP)`) — the dim
					// badge is what makes an MCP call recognizable at a glance.
					mcpName ? "(MCP)" : undefined,
				);
				// TR D3: fused write/edit calls carry then_run — in force mode the
				// core's own call badge is replaced by the CC row, so the badge is
					// re-stated here as a dim second row (read-only; execute untouched).
				const cmd = (args as { then_run?: { command?: string } } | null | undefined)?.then_run?.command;
				return ccThenRunCall(theme as CCTheme, call, cmd);
			};
			// Result factory: direct CC renderer (spec 8.4 — the reference
			// memo never hit: hosts rebuild the envelope on every
			// updateDisplay and reuse the component tree on plain frames;
			// ccResult's width cache absorbs resizes).
			const resultFactory = (result: unknown, options: { expanded?: boolean }, theme: unknown, rctx: { isError?: boolean }) =>
				ccResult(theme as CCTheme, mcpDisplayName(toolName) ?? toolName, result, options, Boolean(rctx?.isError));
			return {
					renderShell: plan.shell === "self" ? ("self" as const) : orig?.renderShell,
					renderCall: plan.call === "cc" ? callFactory : orig?.renderCall,
					renderResult: plan.result === "cc" ? resultFactory : orig?.renderResult,
			};
		});
	}

	// Last-good usage numbers: widget render must survive a stale ctx
	// (session replaced/reloaded) — see setStatusWidget below.
	// Usage numbers observed at message boundaries (plan A7): the branch is
	// frozen while streaming, so per-frame scans were pure waste. Stale-ctx
	// reads reuse the last-good snapshot, never throw inside render.
	const usageTracker = new UsageTracker();
	const observeUsage = (ctx: { sessionManager?: { getBranch?: () => unknown } }) => {
		try {
			usageTracker.observe((ctx.sessionManager?.getBranch?.() ?? []) as never);
		} catch {
			// stale ctx: keep the last-good snapshot
		}
	};
	// Spinner accent paint, refreshed from a live ctx at each transition
	// (state itself lives in runState above).
	let spinnerPaint: (s: string) => string = (s) => s;

	// --- Statusline runner (plan SL4): CC-compatible external script ---
	// Event-driven only (session_start / message_end / model_select / compact
	// / config change / width change) — never per frame. The render path only
	// reads cached lines; spawns live in the runner's async settle callbacks.
	let statuslineRunner: StatuslineRunner | null = null;
	let statuslineWidth = 0; // last render width; a change re-runs the script
	const statuslineCommand = (): string => {
		if (statusLinePrefs.command) return statusLinePrefs.command;
		// Bundled default: the script SOURCE goes straight to `bash -c` — no
		// filesystem anchor exists (pi's jiti loader evaluates extensions from
		// data: URLs, so import.meta.url is useless here). See
		// lib/statusline-default-script.ts.
		return DEFAULT_STATUSLINE_SCRIPT;
	};
	const statuslineOn = (): boolean => enabled && statusLinePrefs.enabled;
	const ensureStatuslineRunner = (): void => {
		if (!statuslineOn() || statuslineRunner) return;
		statuslineRunner = new StatuslineRunner({ command: statuslineCommand() });
		statuslineRunner.setOnUpdate(() => dockTui?.requestRender());
	};
	const teardownStatusline = (): void => {
		statuslineRunner?.dispose();
		statuslineRunner = null;
	};
	const buildCurrentStatuslineInput = (): string => {
		const effort = readEffortLevel(pi);
		return buildStatuslineJson(
			usageTracker.get(),
			{
				displayName: currentModelName || "no model",
				id: currentProviderName ? `${currentProviderName}/${currentModelName || "model"}` : currentModelName,
				provider: currentProviderName,
			},
			currentContextWindow,
			{ cwd: process.cwd(), effort },
		);
	};
	const refreshStatusline = (): void => {
		if (!statuslineRunner) return;
		statuslineRunner.request(buildCurrentStatuslineInput(), statuslineWidth || 100);
	};

	// --- Status widget: compact CC statusline, right-aligned ABOVE the prompt ---
	const setStatusWidget = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("cc-status", (tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				dockTui = tui;
				// Per-frame retry point for the DC5b subscription (idempotent:
				// one null check once attached) — the read below is pure.
				startCoreNotificationConsumer(displayCoreNotification);
				// NOTE: never touch ctx.* in render — after session
				// replacement/reload the captured ctx is stale and any
				// access throws uncaught inside render (kills pi). Model
				// info stays fresh via model_select; usage falls back to
				// last-good values on stale ctx.
				const modelName = currentModelName || "no model";
				const sep = theme.fg("dim", "│");

				const { used, cost } = usageTracker.get();
				const win = currentContextWindow || 0;

				const muted = (s: string) => theme.fg("muted", s);

				// Left: running → spinner frame + verb + esc hint (+ pm token stats
				// when that extension sees this card is active); compacting →
				// "Compacting context…"; idle → the last turn's completion line
				// (✻ Verb for Xs), if any. Right: model (with thinking effort) │
				// context │ cost, right-aligned.
				const pmStats = readPmStatus().workingStats;
				// Shimmer sweep (CC Spinner.tsx): the per-run verb is static; a
				// narrow claudeShimmer band rides the 200ms tick across the word.
				const rv = runState.view();
				const verbText = `${rv.verb}…`;
				const seg = shimmerSegments(verbText, glimmerIndexAt(Date.now() - rv.runStart, visibleWidth(verbText)));
				const verbPainted =
					(seg.before ? spinnerPaint(seg.before) : "") +
					(seg.shimmer ? theme.fg("borderAccent", seg.shimmer) : "") +
					(seg.after ? spinnerPaint(seg.after) : "");
				const left = rv.compacting
					? `${spinnerPaint(SPINNER_FRAMES[rv.spinnerIdx % SPINNER_FRAMES.length])} ${spinnerPaint("Compacting context…")} ${theme.fg("dim", "(esc to cancel)")}`
					: rv.running
						? `${spinnerPaint(SPINNER_FRAMES[rv.spinnerIdx % SPINNER_FRAMES.length])} ${verbPainted} ${theme.fg("dim", `(${formatDuration(Date.now() - rv.runStart)} · esc to interrupt)`)}${pmStats ? ` ${theme.fg("dim", pmStats)}` : ""}`
						: rv.lastWorkedLine
							? theme.fg("dim", rv.lastWorkedLine)
							: "";
				// Plan SL4/D4: with the statusline on, model/effort/ctx/cost live
				// on the script row + right-aligned badge instead — the right
				// group collapses so the same info never shows twice.
				const right = statusLinePrefs.enabled
					? ""
					: buildStatusRightGroup({
						model: modelName,
						effort: readEffortLevel(pi),
						used,
						contextWindow: win,
						cost,
						muted,
						dim: (t) => theme.fg("dim", t),
						sep,
					});
				// Left/right join lives in lib/cc-status-line.ts (table-tested).
				return statusRowLayout(left, right, width);
			},
		}));
	};
	// --- Footer line as belowEditor widget (native-on mode; keeps the
	// footer slot free so other extensions' footers survive) ---
	// One-line footer text shared by both footer modes (slot vs widget).
	// CC behavior: while the input holds text, only the mode label shows —
	// the hints collapse away and return when the input is empty/submitted.
	const editorHasText = (): boolean => {
		try {
			return (activeEditor?.getText() ?? "").trim().length > 0;
		} catch {
			return false;
		}
	};
	const footerLineText = (fgDim: (s: string) => string, width: number): string => {
		// pi-permission-modes publishes its live mode into this env var on
		// every setMode (mode-inherit.ts publishInheritedPermissionMode), so
		// reading it at render time always reflects the current mode, styled
		// with that extension's own icon/label semantics.
		const status = readPmStatus();
		const label = permissionModeLabel(
			status.mode || process.env[PM_MODE_ENV]?.trim(),
			status.meta,
			(mode) => PM_MODE_PAINT[mode] ?? gray,
			gray,
		);
		if (editorHasText()) return truncateToWidth(label, width, "");
		const hints = fgDim("· ! for bash mode · ctrl+p model · ctrl+o tools");
		return truncateToWidth(`${label} ${hints}`, width);
	};

	const setFooterLine = (ctx: ExtensionContext, includeHints: boolean) => {
		ctx.ui.setWidget("cc-footer", (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				// Width changes re-run the script (its layout usually depends on
				// OVERRIDE_TERM_WIDTH); request() debounces and dedups, so this
				// per-frame call only acts on actual changes.
				if (width !== statuslineWidth) {
					statuslineWidth = width;
					refreshStatusline();
				}
				return composeFooterLines({
					statuslineOn: statusLinePrefs.enabled,
					badgeOn: statusLinePrefs.badge,
					lines: statuslineRunner ? statuslineRunner.getRenderLines() : [],
					badgeText: (() => {
						if (!statusLinePrefs.badge) return "";
						// CC-style effort chip (`● high · /effort`): effort only —
						// the script row already names the model. Symbols are CC's
						// ○◐●◉ fill ladder (effortBadgeSymbol); /effort is real
						// (registered by pi-claude-code-core's effort extension).
						const effort = readEffortLevel(pi);
						return effort && effort !== "off" ? `${effortBadgeSymbol(effort)} ${effort} · /effort` : "";
					})(),
					badgePaint: (s) => theme.fg("muted", s),
					hints: includeHints ? footerLineText((s) => theme.fg("dim", s), width) : "",
					width,
				});
			},
		}), { placement: "belowEditor" });
	};

	// Footer-slot version of the mode/hints line (native-off mode). The dock
	// layout reserves minSize:1 for the footer container, so the slot must
	// render exactly one line — an empty footer would leave a blank row and
	// push the editor up instead of docking it at the bottom.
	const setFooterBlankLine = (ctx: ExtensionContext) => {
		// Blank filler for the footer slot. pi ≥0.87 gives the footer row
		// minSize:0 (chat-viewport.js), so rendering zero lines collapses the
		// row entirely — extension widgets (fleet roster) become the bottom
		// row. On pi 0.85.1 the row was minSize:1 and would stay as one blank
		// line; this filler keeps both versions well-formed.
		ctx.ui.setFooter((_tui, _theme) => ({
			invalidate() {},
			render(_width: number): string[] {
				return [];
			},
		}));
	};

	// --- Native footer toggle (/claude-footer) ---
	// showNativeFooter = true  → pi's built-in footer (keeps other
	//   extensions' footers / setStatus texts); mode/hints live as the
	//   cc-footer widget, cc-status hides to avoid duplicating info.
	// showNativeFooter = false → mode/hints join the cc-footer widget
	//   (statusline rows + hints line); the footer slot renders blank to
	//   satisfy the dock's minSize:1. Extension widgets registering later
	//   (pi-subagents' fleet roster) land below the hints, at the bottom.
	// The footer slot is single-occupancy: occupying it is an explicit user
	// choice here, flippable at any time with /claude-footer.
	let showNativeFooter = false;
	const applyFooterMode = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (showNativeFooter) {
			ctx.ui.setFooter(undefined); // restore built-in footer
			ctx.ui.setWidget("cc-status", undefined);
			// Plan SL4/D2: script rows first, mode/hints below them.
			setFooterLine(ctx, true);
		} else {
			setFooterBlankLine(ctx); // dock's minSize:1 row stays reserved, now invisible
			// Mode/hints join the cc-footer widget so they render ABOVE the
			// fleet roster (registered lazily by pi-subagents at first active
			// run → map tail). With the statusline off, composeFooterLines
			// degrades to a hints-only line; refreshStatusline no-ops.
			setFooterLine(ctx, true);
			setStatusWidget(ctx);
			// aboveEditor widgets render in registration order, and this
			// enable() runs in cctui's session_start — before later-loaded
			// extensions (e.g. pi-claude-code-core's goal block) mount
			// theirs. Re-register on the next macrotask: same-key setWidget
			// re-inserts at the map tail, so cc-status (spinner) stays
			// closest to the editor and the goal block sits above it. A
			// microtask is NOT enough — the extension runner's per-handler
			// awaits flush the microtask queue before the next extension's
			// session_start runs.
			const requeue = setTimeout(() => {
				if (enabled) setStatusWidget(ctx);
			}, 0);
			requeue.unref?.();
		}
	};

	// --- Working indicator + verb rotation ---
	// Colors come from the pi theme's accent token (via ctx.ui.theme) instead
	// of a hardcoded brand orange, so the spinner follows the active theme.
	const accentFg = (ctx: ExtensionContext): ((s: string) => string) => {
		try {
			const theme = (ctx.ui as unknown as { theme?: { fg: (c: string, s: string) => string } }).theme;
			if (theme?.fg) return (s) => theme.fg("accent", s);
		} catch {
			// stale ctx — fall back to unstyled text
		}
		return (s) => s;
	};
	const applyWorking = (ctx: ExtensionContext) => {
		spinnerPaint = accentFg(ctx);
		// The spinner renders inside the cc-status row (left side, sharing the
		// line with model/context/cost). pi 0.85+ exposes setWorkingVisible to
		// hide its built-in loader row entirely — the old 占位 approach lost
		// to 0.85.1's new "Working (high effort)…" default text.
		try {
			(ctx.ui as { setWorkingVisible?: (v: boolean) => void }).setWorkingVisible?.(false);
		} catch {
			// older pi without the API: default row stays (best effort)
		}
	};

	// Compaction spinner tick: same 200ms cadence as run ticks, but only the
	// frame advances (no verb rotation). Runs alongside pi's native
	// "Compacting context..." indicator; cleared on compact/failed when idle.
	// Thin event adapters: the transition rules (tick ownership, verb-once,
	// ≥1s completion gating, quiet stop on stale ctx) live in run-state.ts —
	// table-tested there on an injected clock/timer.
	const startRun = (ctx: ExtensionContext) => {
		if (!enabled) return;
		spinnerPaint = accentFg(ctx);
		runState.startRun();
	};

	const endRun = (_ctx: ExtensionContext) => {
		runState.endRun();
	};

	// Accent open-sequence cached from a live ctx (setEditorComponent's
	// theme parameter lacks .fg and crashed the editor on first render).
	let accentOpenAnsi = "\x1b[38;2;138;190;183m"; // sage fallback (#8ABEB7)
	// Live theme fg (cached alongside the accent) for row patches that render
	// outside a renderer's theme parameter (compaction row).
	let themeFg: ((color: string, text: string) => string) | null = null;
	const cacheAccentAnsi = (ctx: ExtensionContext): void => {
		try {
			const t = (ctx.ui as unknown as { theme?: { fg?: (c: string, s: string) => string } }).theme;
			if (t?.fg) themeFg = (c, s) => t.fg!(c, s);
			const seq = t?.fg?.("accent", "");
			if (typeof seq === "string" && seq.includes("38;")) {
				accentOpenAnsi = seq.slice(0, seq.indexOf("m") + 1);
				setEditorAccentOpen(accentOpenAnsi);
			}
		} catch {
			// keep last-good / default sage
		}
	};

	// DC5b: newest context for the notification consumer's display callback
	// (replaced on every enable; stale calls are try/caught downstream).
	let latestCtx: ExtensionContext | null = null;

	const displayCoreNotification = (msg: string, level: string): void => {
		try {
			latestCtx?.ui.notify(msg, level as "info" | "warning" | "error");
		} catch {
			// stale context — drop this one
		}
	};

	// --- Subagent presentation bridge (spec P3) ---
	// Registers the CC fleet drawing with pi-subagents' presentation seam.
	// The bridge owns no theme and no timers: frames carry the current theme
	// per draw and handshakes are bounded. Any failure path leaves the
	// upstream native roster in place — degraded, never blank.
	const subagentBridge = new SubagentPresentationBridge({
		events: pi.events,
		surfaces: { fleet: drawCcFleetFrame, async: drawCcAsyncFrame },
		onDiagnostic: (diagnostic) => {
			// Upstream dedupes per session+reason; this tail is per occurrence.
			console.warn(`[claude-tui] subagent ${diagnostic.surface} drawing fell back to native: ${diagnostic.reason}`);
		},
	});

	const enable = (ctx: ExtensionContext) => {
		enabled = true;
		latestCtx = ctx;
		// DC5b: activate = publish the capability + start consuming core's
		// notification tail queue in one call (withdraw is the single
		// reverse). Returns false while the core bus is v1/not loaded — the
		// explicit retries below re-attempt at session_start and on the
		// status widget's per-frame render, so it attaches right after
		// core's first publish.
		activateCcTuiChannel(displayCoreNotification);
		if (ctx.mode !== "tui") return;
		cacheAccentAnsi(ctx);
		currentModelName = ctx.model?.name || ctx.model?.id || "";
		currentProviderName = ctx.model?.provider || "";
		currentContextWindow = ctx.model?.contextWindow || 0;
		// Tool rows: explicit choice wins; otherwise auto-detect. Detection
		// runs here (not at load) so every extension has registered already.
		// TUI-only: print/RPC modes keep stock rendering. The resolver channel
		// itself is registered at load — here we only resolve the effective
		// switch; new tool-call rows pick it up per construction.
		if (process.env.CC_TUI_TOOL_ROWS === "0" || toolRowsPref === false) {
			toolRowsEnabled = false;
		} else if (toolRowsPref === true) {
			toolRowsEnabled = true;
		} else {
			const owner = externalToolOwner();
			toolRowsEnabled = !owner;
			if (owner) {
				if (!autoYieldNotified) {
					autoYieldNotified = true;
					ctx.ui.notify(`CC tool rows auto-off — tools owned by ${owner} (run /claude-tools on to override)`, "info");
				}
			}
		}
		channelActive = true; // TUI session active (non-TUI enable returned above)
		// Presentation seam: probe → register (or re-register on late hosts).
		// Bounded handshake; no host means native roster stays — never blank.
		try {
			subagentBridge.start(ctx.sessionManager.getSessionId() ?? null);
		} catch {
			// seam transport hiccup: stay native, stay quiet
		}
		patchCompactionRow(() => themeFg);
		patchSkillRow(() => themeFg);
		applyUserBarPatch();
		applyPiHeaderLook(pi, ctx);
		setEditor(ctx);
		applyFooterMode(ctx);
		applyWorking(ctx);
		applyThinkingLook(ctx);
		// Idempotent: re-create the statusline runner after /claude-tui
		// off→on (disable() tore it down). Skip the initial refresh until a
		// render has supplied the real terminal width — the widget's
		// width-diff check triggers the first run, avoiding a wasted
		// wrong-width spawn at startup.
		ensureStatuslineRunner();
		if (statuslineWidth > 0) refreshStatusline();
	};

	const disable = (ctx: ExtensionContext) => {
		enabled = false;
		channelActive = false; // resolver yields stock renderers from now on
		subagentBridge.stop(); // withdraw the CC adapters; native roster returns
		withdrawCcTuiCapability();
		teardownStatusline();
		runState.halt();
		if (ctx.mode !== "tui") return;
		disposePiHeaderLook();
		try {
			(ctx.ui as { setWorkingVisible?: (v: boolean) => void }).setWorkingVisible?.(true);
			ctx.ui.setHiddenThinkingLabel(); // restore pi's default label
		} catch {
			/* older pi */
		}
		ctx.ui.setHeader(undefined);
		ctx.ui.setEditorComponent(undefined);
		activeEditor?.release(); // spec 8.1: disable releases the blink timer too
		activeEditor = null;
		// spec 8.3: withdraw our prototype rewrites (only the ones we still
		// own) so /claude-tui off restores stock rendering.
		restoreCompactionRow();
		restoreSkillRow();
		restoreUserBarPatch();
		// Replica fully off: relinquish the footer slot (restores pi's
		// built-in footer). Single-occupancy caveat still applies, but an
		// explicit off means the user wants stock pi back.
		ctx.ui.setFooter(undefined);
		ctx.ui.setWidget("cc-status", undefined);
		ctx.ui.setWidget("cc-footer", undefined);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
	};

	// (The Plan/Auto mode system was removed — pi-permission-modes owns mode
	// state via its own /mode|/plan|/auto|/bypass commands and Shift+Tab.)

	// (The Plan-Mode system-prompt injection was removed together with the
	// Plan/Auto toggle — pi-permission-modes owns plan-mode gating.)

	// Mirror compaction progress on the cc-status spinner line; compaction
	// also reshapes the context picture, so both events re-run the statusline
	// script (data is cached — one debounced spawn, not a scan).
	pi.on("session_before_compact", async (_event, ctx) => {
		refreshStatusline();
		if (!enabled) return;
		spinnerPaint = accentFg(ctx);
		runState.startCompaction();
		// pi shows its native indicator row before this event fires; mute it
		// so compaction lives only on the cc-status spinner line. Retry a
		// couple of times in case show lands a tick later.
		const hush = (retries: number) => {
			if (silenceNativeCompactionIndicator(dockTui)) return;
			if (retries <= 0) return;
			const t = setTimeout(() => hush(retries - 1), 100);
			t.unref?.();
		};
		hush(4);
	});
	pi.on("session_compact", async (_event, ctx) => {
		runState.stopCompaction();
		observeUsageEvent(ctx, true);
		refreshStatusline();
	});
	pi.on("session_compact_failed", async () => {
		runState.stopCompaction();
	});

	pi.on("session_start", async (_event, ctx) => {
		observeUsage(ctx);
		// Retry point for the DC5b subscription (core may have published its
		// bus only now — enable-time often misses, cctui loads before core).
		startCoreNotificationConsumer(displayCoreNotification);
		enable(ctx); // enable()'s tail ensures/refreshes the statusline (TUI only)
	});

	// Assistant usage: observe at the points USAGE_OBSERVATION_POINTS pins
	// (spec 8.2). message_end alone lags one message — pi notifies extensions
	// before appendMessage persists it — so agent_settled (post-append)
	// guarantees the final value; branch switches and compaction recompute.
	const observeUsageEvent = (ctx: { sessionManager?: { getBranch?: () => unknown } }, refresh: boolean) => {
		observeUsage(ctx);
		if (refresh) refreshStatusline();
	};

	pi.on("message_end", async (_event, ctx) => {
		observeUsage(ctx);
		refreshStatusline();
	});

	pi.on("model_select", async (event, _ctx) => {
		currentModelName = event.model?.name || event.model?.id || "";
		currentProviderName = event.model?.provider || "";
		currentContextWindow = event.model?.contextWindow || 0;
		refreshStatusline();
	});

	pi.on("agent_start", async (_event, ctx) => {
		startRun(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		endRun(ctx);
		// Post-append guarantee (spec 8.2): the final assistant message is in
		// the branch by the time the run settles — no follow-up user message
		// needed for the statusline to show the real totals.
		observeUsageEvent(ctx, true);
	});

	// Branch invalidations (spec 8.2): switching/resuming a branch and
	// compaction both replace what getBranch() returns — recompute, never
	// carry stale totals across.
	pi.on("session_tree", async (_event, ctx) => {
		observeUsageEvent(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runState.halt();
		teardownStatusline();
		activeEditor?.release(); // spec 8.1: no blink timer outlives the session
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setEditorComponent(undefined);
		}
	});

	pi.registerCommand("claude-tui", {
		description: "Toggle the Claude Code TUI replica (header / editor / spinner / status line)",
		handler: async (_args, ctx) => {
			if (enabled) {
				disable(ctx);
				ctx.ui.notify("Claude Code TUI replica disabled", "info");
			} else {
				enable(ctx);
				ctx.ui.notify("Claude Code TUI replica enabled", "info");
			}
		},
	});

	pi.registerCommand("claude-tools", {
		description: "CC tool rows: on | off | auto (auto yields to other TUI extensions)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "auto" || (a !== "on" && a !== "off" && toolRowsPref === undefined)) {
				// Back to / explicit auto-detect. The resolver reads these flags
				// per tool-call construction, so new rows pick the mode up
				// immediately; already-rendered rows keep their renderers.
				toolRowsPref = undefined;
				saveToolRowsPref(undefined);
				const owner = externalToolOwner();
				toolRowsEnabled = !owner;
				if (owner) {
					ctx.ui.notify(`CC tool rows auto-off — tools owned by ${owner} (run /claude-tools on to override)`, "info");
				} else {
					ctx.ui.notify("CC tool rows auto-on — no other owner detected", "info");
				}
				return;
			}
			const next = a === "on" ? true : a === "off" ? false : !toolRowsEnabled;
			toolRowsPref = next;
			toolRowsEnabled = next;
			saveToolRowsPref(next);
			if (next) {
				ctx.ui.notify("CC tool rows on — every new tool call renders as CC rows (other renderers yield; execute untouched)", "info");
			} else {
				ctx.ui.notify("CC tool rows off — new tool calls render stock (another TUI extension, if any, takes over immediately)", "info");
			}
		},
	});

	pi.registerCommand("claude-verb", {
		description: "Reroll the Claude Code spinner verb",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`✻ ${runState.rerollVerb()}…`, "info");
		},
	});

	pi.registerCommand("claude-footer", {
		description: "Toggle pi's native footer (on: keep MCP/other footers, hide CC status widget; off: CC-clean look)",
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (a === "on" || a === "off") showNativeFooter = a === "on";
			else showNativeFooter = !showNativeFooter;
			if (enabled) applyFooterMode(ctx);
			ctx.ui.notify(
				`Native footer ${showNativeFooter ? "on — CC status widget hidden" : "off — CC status widget shown"}`,
				"info",
			);
		},
	});

	// Plan SL4: CC-compatible statusline (external script; JSON on stdin).
	pi.registerCommand("claude-statusline", {
		description: "Statusline: on | off | badge on|off | set <command>",
		handler: async (args, ctx) => {
			const a = args.trim();
			const badgeMatch = a.match(/^badge\s+(on|off)$/i);
			const setMatch = a.match(/^set\s+(.+)$/i);
			if (badgeMatch) {
				statusLinePrefs = { ...statusLinePrefs, badge: badgeMatch[1]!.toLowerCase() === "on" };
			} else if (setMatch) {
				// `set` implies on — setting a script is an intent to use it;
				// saving it dark confused users ("set 之后没反应").
				statusLinePrefs = { ...statusLinePrefs, command: setMatch[1]!.trim(), enabled: true };
				teardownStatusline(); // recreate with the new command
			} else if (a === "" || a === "on" || a === "off") {
				statusLinePrefs = {
					...statusLinePrefs,
					enabled: a === "" ? !statusLinePrefs.enabled : a === "on",
				};
				if (!statusLinePrefs.enabled) teardownStatusline();
			} else {
				ctx.ui.notify("Usage: /claude-statusline [on|off|badge on|off|set <command>]", "info");
				return;
			}
			savePrefs({ statusLine: statusLinePrefs }, prefsPath);
			if (enabled) {
				ensureStatuslineRunner();
				refreshStatusline();
				applyFooterMode(ctx);
			}
			ctx.ui.notify(
				`Statusline ${statusLinePrefs.enabled ? "on" : "off"}${badgeMatch ? ` — badge ${statusLinePrefs.badge ? "on" : "off"}` : ""}${setMatch ? ` — command: ${statusLinePrefs.command}` : ""}`,
				"info",
			);
		},
	});

	// Tool registration happens in enable() (session_start), never at load:
	// detection needs every extension registered, and non-TUI modes keep
	// stock rendering. Nothing to do here.

	// Compact CC-style user bars: UserMessageComponent wraps content in a Box
	// with hardcoded paddingY=1 (a blank row above and below the bar). Patch
	// rebuild to zero it so the bar sits tight against neighboring messages.
	// Same centralized lifecycle as the compaction/skill rows (spec 8.3).
	const userBarAdapter = new PrototypeMethodAdapter({
		proto: UserMessageComponent.prototype,
		method: "rebuild",
		marker: "__ccCompact",
		hostMatches: (host): boolean => Array.isArray((host as { children?: unknown })?.children),
		// Wrapper-style patch (spec 8.3): run the native rebuild FIRST, then
		// zero the Box padding — a replacement-style body here would leave the
		// component empty and user messages would vanish from the transcript.
		body: (host, _fg, original) => {
			original?.call(host);
			for (const child of (host as { children?: Array<{ paddingY?: number }> }).children ?? []) {
				if (child && typeof child.paddingY === "number" && child.paddingY > 0) child.paddingY = 0;
			}
		},
	});
	const applyUserBarPatch = (): void => userBarAdapter.apply(() => null);
	const restoreUserBarPatch = (): void => userBarAdapter.restore();

	// History user messages: CC-style slim bar — dim `❯` at column 0 (outputPad
	// setting is 0) on a one-row near-black background spanning the content
	// width. Continuation lines indent 2 cols so no glyph ever shares ❯'s
	// column, like CC. Display-only: session and model context keep the
	// original text.
	// CC renders conversation text explicitly white; pi leaves it at the
	// terminal default (which can be any color, e.g. Gruvbox cream).
	// Assistant/user markdown styling lives in lib/cc-markdown.ts (pure,
	// table-tested); the transformer itself only routes by message type.
	pi.registerMarkdownTransformer((markdown, { messageType, availableWidth }) => {
		if (messageType === "assistant") return assistantWhiteText(markdown);
		if (messageType !== "user") return markdown;
		return userMessageBar(markdown, Math.max(1, Math.floor(availableWidth ?? 80)), gray);
	});
}
