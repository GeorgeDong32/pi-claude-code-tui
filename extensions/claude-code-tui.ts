/**
 * Claude Code TUI 复刻扩展（v2 — 全页面复刻）
 * 参考 Claude Code 官方源码 UI（spinnerVerbs / Clawd / BuiltinStatusLine / PromptInput /
 * AssistantToolUseMessage），在 pi 上复刻其 TUI 观感：
 * - 启动头：Clawd 吉祥物 + "Claude Code vX" + 模型名（第三方模型名原样保留）+ cwd
 * - 输入框：CC 式半开圆角边框（只有上下边）+ accent 块状光标（移植自 MIT 的
 *   pi-claude-code-tui 包，见 lib/claude-tui-editor.ts）
 * - 工具行：用公共 API 实例化内置工具并原样委托 execute，只覆写渲染为
 *   CC 风格 `⏺ Tool(args)` + `⎿  输出`（错误红色、edit 带彩色 diff、
 *   read 折叠摘要），renderShell "self" 去掉背景盒；折叠按物理行封顶
 *   3 行（长 JSON 行 wrap 后也不会刷屏）
 * - 第三方/MCP 工具兜底：原型补丁 ToolExecutionComponent，凡无自带
 *   renderCall/renderResult 的工具（MCP、task 等）同样渲染为折叠的 CC 行；
 *   显式 on（/claude-tools on）时进一步接管自带渲染器的第三方工具
 *   （如 SoL-Pi 的 obs_recall / 融合 edit/write）——只换渲染器，
 *   execute 与参数保持对方实现，功能不受影响
 * - Thinking 折叠：折叠开关本身是 pi 原生设置（hideThinkingBlock / ctrl+t），
 *   本扩展只把折叠标签换成 CC 风格 `✻ Thinking… (ctrl+t to expand)`，
 *   并在用户未做过选择时一次性提示快捷键
 * - Spinner：✻ 花型动画 + Claude 橙 + 190 个 Claude Code 俏皮动词轮换 + (esc to interrupt · Ns)
 * - 收尾：✻ Worked for 12s（CC 过去式动词）
 * - 状态栏：模型 │ Context 23% (50k/200k) │ $0.042（/claude-footer 切换；
 *   开原生底栏时自动隐藏，避免与 pi-mcp-adapter / pi-lens 的 footer 重复）
 *
 * Commands:
 *   /claude-tui  — 开/关整套复刻 UI（头 / 输入框 / 转圈 / 状态栏，不含工具行）
 *   /claude-tools — CC 工具行：on / off / auto（auto 碰到别家自动让路）
 *   /claude-verb — 立即换一个随机动词
 *   /claude-footer — 开/关原生底栏（开：兼容其它扩展 footer；关：CC 极简风）
 */

import { VERSION, keyText, ToolExecutionComponent, UserMessageComponent, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, renderDiff } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	ccCall,
	ccResult,
	callArgsFor,
	dotStatus,
	thinkingToggleHint,
	type CCTheme,
} from "./lib/cc-rows.ts";
import { CodexStyleEditor, cursorOpenFromFgAnsi, setEditorAccentOpen } from "./lib/claude-tui-editor.ts";
import { UsageTracker } from "./lib/status-snapshot.ts";
import {
	buildStatuslineJson,
	composeFooterLines,
	StatuslineRunner,
} from "./lib/statusline.ts";
import { DEFAULT_STATUSLINE_SCRIPT } from "./lib/statusline-default-script.ts";
import { buildCompletionLine, formatCost, formatDuration, formatTokens } from "./lib/render-utils.ts";
import {
	defaultPrefsPath,
	loadPrefs,
	resolveStatusLinePrefs,
	savePrefs,
	type ClaudeTuiPrefs,
	type StatusLinePrefs,
} from "./lib/prefs.ts";
import {
	PM_MODE_ENV,
	publishCcTuiCapability,
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

// --- 190 playful verbs (src/constants/spinnerVerbs.ts) ---
const SPINNER_VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming",
	"Beboppin'", "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing",
	"Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing",
	"Calculating", "Canoodling", "Caramelizing", "Cascading", "Catapulting",
	"Cerebrating", "Channeling", "Channelling", "Choreographing", "Churning",
	"Clauding", "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing",
	"Concocting", "Considering", "Contemplating", "Cooking", "Crafting", "Creating",
	"Crunching", "Crystallizing", "Cultivating", "Deciphering", "Deliberating",
	"Determining", "Dilly-dallying", "Discombobulating", "Doing", "Doodling",
	"Drizzling", "Ebbing", "Effecting", "Elucidating", "Embellishing", "Enchanting",
	"Envisioning", "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling",
	"Flambéing", "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering",
	"Forging", "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping",
	"Garnishing", "Generating", "Gesticulating", "Germinating", "Gitifying",
	"Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding",
	"Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining",
	"Improvising", "Incubating", "Inferring", "Infusing", "Ionizing",
	"Jitterbugging", "Julienning", "Kneading", "Leavening", "Levitating",
	"Lollygagging", "Manifesting", "Marinating", "Meandering", "Metamorphosing",
	"Misting", "Moonwalking", "Moseying", "Mulling", "Mustering", "Musing",
	"Nebulizing", "Nesting", "Newspapering", "Noodling", "Nucleating", "Orbiting",
	"Orchestrating", "Osmosing", "Perambulating", "Percolating", "Perusing",
	"Philosophising", "Photosynthesizing", "Pollinating", "Pondering",
	"Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing",
	"Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing",
	"Razzle-dazzling", "Razzmatazzing", "Recombobulating", "Reticulating",
	"Roosting", "Ruminating", "Sautéing", "Scampering", "Schlepping", "Scurrying",
	"Seasoning", "Shenaniganing", "Shimmying", "Simmering", "Skedaddling",
	"Sketching", "Slithering", "Smooshing", "Sock-hopping", "Spelunking",
	"Spinning", "Sprouting", "Stewing", "Sublimating", "Swirling", "Swooping",
	"Symbioting", "Synthesizing", "Tempering", "Thinking", "Thundering",
	"Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring", "Transmuting",
	"Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing", "Waddling",
	"Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
	"Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
];

// Past-tense verbs for turn completion (src/constants/turnCompletionVerbs.ts)
const TURN_COMPLETION_VERBS = [
	"Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked",
];

const randomOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

const shortenCwd = (): string => {
	const cwd = process.cwd();
	return cwd.replace(/^\/Users\/[^/]+/, "~");
};

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
			for (const name of ["read", "bash", "grep", "find", "ls", "write", "edit"]) {
				const source = tools.find((tool) => tool?.name === name)?.sourceInfo?.source;
				if (typeof source === "string" && source !== "builtin" && !source.includes("claude-code-tui")) return source;
			}
		} catch {
			// getAllTools is unavailable before the extension runtime is bound.
		}
		return undefined;
	};
	let verb = randomOf(SPINNER_VERBS);
	let runStart = 0;
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	let currentModelName = "";
	let currentProviderName = "";
	let currentContextWindow = 0;

	// --- Editor: flat rules + orange ❯ + rotating "Try ..." placeholder ---
	// (The built-in Plan/Auto mode system was removed in the permission-modes
	// integration: pi-permission-modes owns mode state — ask/plan/auto/bypass
	// on Shift+Tab — and this extension's footer renders its published mode.)
	let activeEditor: CodexStyleEditor | null = null;
	let dockTui: { requestRender: (force?: boolean) => void } | null = null;

	// --- Editor: flat rules + gold ❯ + blinking bar cursor ---
	const setEditor = (ctx: ExtensionContext) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			// NOTE: the factory body runs synchronously inside
			// setEditorComponent (ctx live), but cursorOpen fires on every
			// editor render — it must not touch ctx (stale after session
			// replace/reload → uncaught throw kills pi).
			// The prompt follows the theme accent; the cursor bar mimics a
			// terminal-native caret (light gray block, dark text).
			activeEditor = new CodexStyleEditor(tui, theme, keybindings, () =>
				cursorOpenFromFgAnsi("\x1b[38;2;215;215;215m"),
			);
			return activeEditor;
		});
	};

	// --- Fallback CC rows for third-party/MCP tools ---
	// Tools registered by other extensions (MCP adapters, pi-task, …) ship no
	// renderCall/renderResult, so pi's fallback floods the transcript with 10+
	// wrapped lines. Prototype-patch ToolExecutionComponent (same module
	// instance pi's TUI uses, like the UserMessageComponent patch below) so any
	// tool WITHOUT its own renderers gets CC-style collapsed rows; tools that
	// do define renderers keep them — except in force mode (/claude-tools on,
	// explicit pref): there the CC rows take over every non-built-in tool too
	// (e.g. SoL-Pi's fused edit/write and obs_recall), because the factory
	// only swaps the renderers — execute and parameters stay the other
	// extension's, so behavior (action fusion, recall pages) is unchanged.
	const patchThirdPartyToolRows = () => {
		const proto = ToolExecutionComponent.prototype as unknown as {
			toolName: string;
			args: unknown;
			toolDefinition?: unknown;
			builtInToolDefinition?: unknown;
			getCallRenderer: () => unknown;
			getResultRenderer: () => unknown;
			getRenderShell: () => string;
			__ccRowsPatched?: boolean;
		};
		if (proto.__ccRowsPatched) return;
		const origCall = proto.getCallRenderer;
		const origResult = proto.getResultRenderer;
		const origShell = proto.getRenderShell;
		// pi internals moved: skip the third-party fallback patch loudly
		// instead of rendering garbage (plan B4 guard).
		if (typeof origCall !== "function" || typeof origResult !== "function") {
			console.warn("[claude-tui] ToolExecutionComponent renderer hooks not found — third-party tool rows stay pi-default");
			return;
		}
		const isBuiltin = (self: { builtInToolDefinition?: unknown }) => self.builtInToolDefinition !== undefined;
		// Force mode = explicit user choice (toolRowsPref === true). Auto mode
		// keeps the old yield-to-renderers contract.
		const forceRows = () => enabled && toolRowsEnabled && toolRowsPref === true;
		// Tools whose own result renderer is live, information-dense UI that
		// force mode must NOT flatten into a 3-row preview: pi-subagents'
		// `subagent` renders a live workflow card (per-agent progress, tokens,
		// checklists) inside the tool block — taking it over pushed all that
		// state down into the belowEditor "Async agents" widget and left a
		// bare "Workflow running." line (the CC design keeps progress INLINE
		// under the call row; pi-subagents' coverage mechanism also hides
		// widget rows already covered by the inline card, so exempting the
		// result restores that split). Banner-style renderers (SoL-Pi's ⚡
		// blocks) stay taken over — they carry no live detail. The call row
		// is still ours (CC ⏺ row + subagentCallSummary), inside the same
		// flat "self" container.
		const FORCE_RESULT_EXEMPT = new Set(["subagent"]);
		// NOTE: theme must come from pi core's factory args (always live).
		// Never capture ctx.ui.theme here: a session_start ctx goes stale
		// after newSession/fork/switchSession/reload, and touching ctx.ui
		// inside render() throws where pi can't catch it (kills pi).
		proto.getCallRenderer = function () {
			const orig = origCall.call(this);
			if (!enabled || !toolRowsEnabled || isBuiltin(this)) return orig;
			if (orig && !forceRows()) return orig;
			// renderCall is a factory: (args, theme, ctx) => component
			return (args: unknown, theme: unknown, rctx?: { isError?: boolean; isPartial?: boolean }) =>
				ccCall(theme as CCTheme, this.toolName, callArgsFor(this.toolName, args), dotStatus(rctx));
		};
		proto.getResultRenderer = function () {
			const orig = origResult.call(this);
			if (!enabled || !toolRowsEnabled || isBuiltin(this)) return orig;
			if (orig && (!forceRows() || FORCE_RESULT_EXEMPT.has(this.toolName))) return orig;
			// Component memo (plan A6, same as the registered-override path):
			// pi re-invokes getResultRenderer() every frame, so a closure here
			// would be rebuilt per frame — the cache rides on the component
			// instance instead. Force mode serves edit diffs and read
			// summaries through here, which are costly enough to notice.
			const self = this as { toolName: string; __ccResultMemo?: {
				factory: unknown;
				key: { result: unknown; expanded: boolean | undefined; isError: boolean; theme: unknown };
				component: ReturnType<typeof ccResult>;
			} };
			return (result: unknown, options: { expanded?: boolean }, theme: unknown, rctx: { isError?: boolean }) => {
				const isError = Boolean(rctx?.isError);
				const expanded = options?.expanded;
				const memo = self.__ccResultMemo;
				if (memo && memo.factory === orig) {
					// Same definition renderer means same tool identity for
					// this component instance.
					if (
						memo.key.result === result &&
						memo.key.expanded === expanded &&
						memo.key.isError === isError &&
						memo.key.theme === theme
					) {
						return memo.component;
					}
				}
				const component = ccResult(theme as CCTheme, self.toolName, result, options, isError);
				self.__ccResultMemo = {
					factory: orig,
					key: { result, expanded, isError, theme },
					component,
				};
				return component;
			};
		};
		// Drop the pending/success background box for third-party tools so they
		// match the flat CC look of the overridden built-ins.
		proto.getRenderShell = function () {
			if (enabled && toolRowsEnabled && !isBuiltin(this) && this.toolDefinition !== undefined) return "self";
			return origShell.call(this);
		};
		proto.__ccRowsPatched = true;
	};

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
	// Turn-completion line (✻ Verb for Xs) rendered at the end of the status
	// widget row instead of being injected into the chat transcript.
	let lastWorkedLine = "";
	// Live spinner state for the cc-status left side (running vs completion).
	let running = false;
	let spinnerIdx = 0;
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
		const effort = (() => {
			try {
				return (pi as { getThinkingLevel?: () => string | undefined }).getThinkingLevel?.();
			} catch {
				return undefined;
			}
		})();
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
				// NOTE: never touch ctx.* in render — after session
				// replacement/reload the captured ctx is stale and any
				// access throws uncaught inside render (kills pi). Model
				// info stays fresh via model_select; usage falls back to
				// last-good values on stale ctx.
				const modelName = currentModelName || "no model";
				const sep = theme.fg("dim", "│");

				const { used, cost } = usageTracker.get();
				const win = currentContextWindow || 0;
				const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0;

				const muted = (s: string) => theme.fg("muted", s);

				// Left: turn-completion line (✻ Verb for Xs). Right: model (with
				// thinking effort) │ context │ cost, right-aligned.
				// Running: spinner frame + verb + esc hint on the left. Idle:
				// the last turn's completion line (✻ Verb for Xs), if any.
				// Running: spinner frame + verb + esc hint, then pi-permission-modes'
				// token stats (published via __pmWorkingStats when that extension
				// sees this card is active). Idle: last turn's completion line.
				const pmStats = readPmStatus().workingStats;
				const left = running
					? `${spinnerPaint(SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length])} ${spinnerPaint(`${verb}…`)} ${theme.fg("dim", `(${formatDuration(Date.now() - runStart)} · esc to interrupt)`)}${pmStats ? ` ${theme.fg("dim", pmStats)}` : ""}`
					: lastWorkedLine
						? theme.fg("dim", lastWorkedLine)
						: "";
				// Plan SL4/D4: with the statusline on, model/effort/ctx/cost live
				// on the script row + right-aligned badge instead — the right
				// group collapses so the same info never shows twice.
				let right = "";
				if (!statusLinePrefs.enabled) {
					const effort = (() => {
						try {
							return (pi as { getThinkingLevel?: () => string | undefined }).getThinkingLevel?.();
						} catch {
							return undefined;
						}
					})();
					const modelLabel = effort ? `${modelName}·${effort}` : modelName;
					const rightParts = [muted(modelLabel)];
					if (win > 0 && used > 0) {
						rightParts.push(
							`${theme.fg("dim", "Ctx ")}${muted(`${pct}%`)}${theme.fg("dim", `(${formatTokens(used)}/${formatTokens(win)})`)}`,
						);
					}
					if (cost > 0) {
						rightParts.push(muted(formatCost(cost)));
					}
					right = rightParts.join(sep);
				}

				// Left-aligned completion line, right-aligned model/context/cost.
				// Degrades to plain left truncation when the two cannot fit.
				const leftW = visibleWidth(left);
				if (right === "") return [truncateToWidth(left, width)];
				const rightW = visibleWidth(right);
				if (leftW + rightW + 2 <= width) {
					const pad = " ".repeat(Math.max(2, width - leftW - rightW));
					return [truncateToWidth(`${left}${pad}${right}`, width)];
				}
				return [truncateToWidth(`${left}  ${right}`, width)];
			},
		}));
	};
	// --- Tool rendering overrides: delegate execute to real built-ins ---
	// Shared builder so the CC overrides and the stock natives stay in sync.
	const buildBuiltins = () => {
		const cwd = process.cwd();
		return {
			read: createReadToolDefinition(cwd),
			bash: createBashToolDefinition(cwd),
			grep: createGrepToolDefinition(cwd),
			find: createFindToolDefinition(cwd),
			ls: createLsToolDefinition(cwd),
			write: createWriteToolDefinition(cwd),
			edit: createEditToolDefinition(cwd),
		};
	};
	const registerToolOverrides = () => {
		const builtins = buildBuiltins();

		const registerCC = (name: string, builtin: { name: string }, override: { renderCall: unknown; renderResult: unknown }) => {
			pi.registerTool({
				...builtin,
				...override,
				renderShell: "self" as const,
			} as Parameters<typeof pi.registerTool>[0]);
		};

		const ccRenderers = (name: string) => {
			// Component memo (plan A6): pi calls renderResult every frame; reuse
			// the component (and its wrap cache) while the inputs are the same
			// references. A new result object (streaming partials) misses naturally.
			let resultMemo: {
				key: { result: unknown; expanded: boolean | undefined; isError: boolean; theme: unknown };
				component: ReturnType<typeof ccResult>;
			} | null = null;
			return {
				renderCall(args: unknown, theme: unknown, context: unknown) {
					return ccCall(theme as CCTheme, name, callArgsFor(name, args), dotStatus(context as { isError?: boolean; isPartial?: boolean }));
				},
				renderResult(result: unknown, options: unknown, theme: unknown, context: unknown) {
					const opts = options as { expanded?: boolean };
					const isError = Boolean((context as { isError?: boolean })?.isError);
					if (
						resultMemo &&
						resultMemo.key.result === result &&
						resultMemo.key.expanded === opts?.expanded &&
						resultMemo.key.isError === isError &&
						resultMemo.key.theme === theme
					) {
						return resultMemo.component;
					}
					resultMemo = {
						key: { result, expanded: opts?.expanded, isError, theme },
						component: ccResult(theme as CCTheme, name, result, opts, isError),
					};
					return resultMemo.component;
				},
			};
		};

		registerCC("read", builtins.read, ccRenderers("read"));
		registerCC("bash", builtins.bash, ccRenderers("bash"));
		registerCC("grep", builtins.grep, ccRenderers("grep"));
		registerCC("find", builtins.find, ccRenderers("find"));
		registerCC("ls", builtins.ls, ccRenderers("ls"));
		registerCC("write", builtins.write, ccRenderers("write"));
		registerCC("edit", builtins.edit, ccRenderers("edit"));
	};

	// Stock natives (same definitions, no render overrides): re-registered
	// when the user turns the CC tool rows off at runtime, so the transcript
	// immediately stops using CC rows. Another TUI extension that owns tool
	// rendering takes over fully after a /reload (load order decides).
	const registerNativeTools = () => {
		const builtins = buildBuiltins();
		for (const builtin of Object.values(builtins)) {
			pi.registerTool(builtin as Parameters<typeof pi.registerTool>[0]);
		}
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
		const permissionModeLabel = (): string => {
			const status = readPmStatus();
			const pm = status.mode || process.env[PM_MODE_ENV]?.trim();
			if (!pm) return "";
			const paint = PM_MODE_PAINT[pm] ?? gray;
			// DC1: icon/label single-sourced from core's MODE_META via the bus
			// projection; bare mode key + local paint is the older-core fallback.
			const m = status.meta?.[pm];
			const icon = m?.icon ?? "●";
			const label = m ? `${m.label.toLowerCase()} mode` : `${pm} mode`;
			return `${paint(`${icon} ${label} on`)}${gray(" (shift+tab to cycle)")}`;
		};
		const label = permissionModeLabel();
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
						let effort: string | undefined;
						try {
							effort = (pi as { getThinkingLevel?: () => string | undefined }).getThinkingLevel?.();
						} catch {
							effort = undefined;
						}
						// CC-style effort chip (`⊙ xhigh · /effort`): effort only —
						// the script row already names the model. /effort is real
						// (registered by pi-claude-code-core's effort extension).
						return effort && effort !== "off" ? `⊙ ${effort} · /effort` : "";
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
	const setFooterModeLine = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return [footerLineText((s) => theme.fg("dim", s), width)];
			},
		}));
	};

	// --- Native footer toggle (/claude-footer) ---
	// showNativeFooter = true  → pi's built-in footer (keeps other
	//   extensions' footers / setStatus texts); mode/hints live as the
	//   cc-footer widget, cc-status hides to avoid duplicating info.
	// showNativeFooter = false → footer slot renders mode/hints (fills its
	//   minSize:1, editor stays docked); cc-status widget shows above input.
	// The footer slot is single-occupancy: occupying it is an explicit user
	// choice here, flippable at any time with /claude-footer.
	// Default off = v1.2.0 look, zero visual regression for existing users.
	let showNativeFooter = false;
	const applyFooterMode = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (showNativeFooter) {
			ctx.ui.setFooter(undefined); // restore built-in footer
			ctx.ui.setWidget("cc-status", undefined);
			// Plan SL4/D2: script rows first, mode/hints below them.
			setFooterLine(ctx, true);
		} else {
			setFooterModeLine(ctx); // fills footer's minSize:1, no gap
			if (statusLinePrefs.enabled) {
				setFooterLine(ctx, false); // statusline-only belowEditor widget
			} else {
				ctx.ui.setWidget("cc-footer", undefined);
			}
			setStatusWidget(ctx);
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

	const startRun = (ctx: ExtensionContext) => {
		if (!enabled) return;
		lastWorkedLine = "";
		running = true;
		runStart = Date.now();
		verb = randomOf(SPINNER_VERBS);
		spinnerPaint = accentFg(ctx);
		if (tickTimer) clearInterval(tickTimer);
		let ticks = 0;
		// 200ms per spinner frame — calmer than the old 120ms; the verb
		// rotates every ~2s. Each tick just flips state and re-renders the
		// widget (no setWorkingMessage).
		tickTimer = setInterval(() => {
			try {
				ticks++;
				spinnerIdx++;
				if (ticks % 10 === 0) verb = randomOf(SPINNER_VERBS);
				// Non-forced render keeps pi's line-diff cache intact (plan A8).
				dockTui?.requestRender();
			} catch {
				// ctx went stale (session replaced/reloaded mid-run): stop
				// ticking quietly instead of throwing uncaught (kills pi).
				if (tickTimer) {
					clearInterval(tickTimer);
					tickTimer = null;
				}
			}
		}, 200);
	};

	const endRun = (ctx: ExtensionContext) => {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
		running = false;
		if (!enabled || runStart === 0) return;
		const endTs = Date.now();
		const elapsed = endTs - runStart;
		runStart = 0;
		if (elapsed >= 1000) {
			// Completion line lives in the status widget (bottom of the screen)
			// instead of being injected into the chat transcript. Plan SL1/D0:
			// duration + wall-clock end time, rendered dim below.
			lastWorkedLine = buildCompletionLine(randomOf(TURN_COMPLETION_VERBS), elapsed, endTs);
			dockTui?.requestRender();
		}
	};

	// Accent open-sequence cached from a live ctx (setEditorComponent's
	// theme parameter lacks .fg and crashed the editor on first render).
	let accentOpenAnsi = "\x1b[38;2;138;190;183m"; // sage fallback (#8ABEB7)
	const cacheAccentAnsi = (ctx: ExtensionContext): void => {
		try {
			const t = (ctx.ui as unknown as { theme?: { fg?: (c: string, s: string) => string } }).theme;
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

	const enable = (ctx: ExtensionContext) => {
		enabled = true;
		latestCtx = ctx;
		(pi as { getAllTools?: unknown }).getAllTools; // touch to fail fast on stale
		publishCcTuiCapability();
		// DC5b: consume core's notification tail queue ourselves (the
		// capability declaration above makes core drop its direct forward).
		// Returns false while the core bus is v1/not loaded — readPmStatus
		// retries every frame, so it attaches right after core's first
		// publish.
		startCoreNotificationConsumer((msg, level) => {
			try {
				latestCtx?.ui.notify(msg, level as "info" | "warning" | "error");
			} catch {
				// stale context — drop this one
			}
		});
		if (ctx.mode !== "tui") return;
		cacheAccentAnsi(ctx);
		currentModelName = ctx.model?.name || ctx.model?.id || "";
		currentProviderName = ctx.model?.provider || "";
		currentContextWindow = ctx.model?.contextWindow || 0;
		// Tool rows: explicit choice wins; otherwise auto-detect. Detection
		// runs here (not at load) so every extension has registered already.
		// TUI-only: print/RPC modes keep stock rendering.
		if (process.env.CC_TUI_TOOL_ROWS === "0" || toolRowsPref === false) {
			toolRowsEnabled = false;
		} else if (toolRowsPref === true) {
			toolRowsEnabled = true;
			registerToolOverrides();
		} else {
			const owner = externalToolOwner();
			toolRowsEnabled = !owner;
			if (owner) {
				if (!autoYieldNotified) {
					autoYieldNotified = true;
					ctx.ui.notify(`CC tool rows auto-off — tools owned by ${owner} (run /claude-tools on to override)`, "info");
				}
			} else {
				registerToolOverrides();
			}
		}
		patchThirdPartyToolRows();
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
		running = false;
		withdrawCcTuiCapability();
		teardownStatusline();
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
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

	pi.on("session_start", async (_event, ctx) => {
		observeUsage(ctx);
		enable(ctx); // enable()'s tail ensures/refreshes the statusline (TUI only)
	});

	// Assistant usage finalizes at message_end — that is the only moment the
	// branch's usage totals can change (plan A7).
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

	// Compaction reshapes the context picture — rerun the script (its data is
	// cached; this is one debounced spawn, not a scan).
	pi.on("session_compact", async () => {
		refreshStatusline();
	});
	pi.on("session_before_compact", async () => {
		refreshStatusline();
	});

	pi.on("agent_start", async (_event, ctx) => {
		startRun(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		endRun(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
		teardownStatusline();
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
				// Back to / explicit auto-detect.
				toolRowsPref = undefined;
				saveToolRowsPref(undefined);
				const owner = externalToolOwner();
				toolRowsEnabled = !owner;
				if (owner) {
					registerNativeTools();
					ctx.ui.notify(`CC tool rows auto-off — tools owned by ${owner} (run /claude-tools on to override)`, "info");
				} else {
					registerToolOverrides();
					ctx.ui.notify("CC tool rows auto-on — no other owner detected", "info");
				}
				return;
			}
			const next = a === "on" ? true : a === "off" ? false : !toolRowsEnabled;
			toolRowsPref = next;
			toolRowsEnabled = next;
			saveToolRowsPref(next);
			if (next) {
				registerToolOverrides();
				ctx.ui.notify("CC tool rows on — every tool renders as CC rows (other renderers yield; execute untouched)", "info");
			} else {
				registerNativeTools();
				ctx.ui.notify("CC tool rows off — run /reload if another TUI extension should take over tool rendering", "info");
			}
		},
	});

	pi.registerCommand("claude-verb", {
		description: "Reroll the Claude Code spinner verb",
		handler: async (_args, ctx) => {
			verb = randomOf(SPINNER_VERBS);
			ctx.ui.notify(`✻ ${verb}…`, "info");
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
	const userProto = UserMessageComponent.prototype as unknown as { rebuild: () => void; __ccCompact?: boolean };
	if (!userProto.__ccCompact) {
		const origRebuild = userProto.rebuild;
		userProto.rebuild = function (this: { children?: Array<{ paddingY?: number }> }) {
			origRebuild.call(this);
			for (const child of this.children ?? []) {
				if (child && typeof child.paddingY === "number" && child.paddingY > 0) child.paddingY = 0;
			}
		};
		userProto.__ccCompact = true;
	}

	// History user messages: CC-style slim bar — dim `❯` at column 0 (outputPad
	// setting is 0) on a one-row near-black background spanning the content
	// width. Continuation lines indent 2 cols so no glyph ever shares ❯'s
	// column, like CC. Display-only: session and model context keep the
	// original text.
	// CC renders conversation text explicitly white; pi leaves it at the
	// terminal default (which can be any color, e.g. Gruvbox cream). Force
	// white on plain lines; markdown-styled lines (headings, lists, code,
	// tables) keep their own theme colors.
	const WHITE = "\x1b[38;2;255;255;255m";
	const plainLine = (l: string) => !/^(\s*[#>*`\-|]|\s*\d+\.)/.test(l) && l.trim() !== "";

	pi.registerMarkdownTransformer((markdown, { messageType, availableWidth }) => {
		if (messageType === "assistant") {
			let inFence = false;
			return markdown
				.split("\n")
				.map((l) => {
					if (/^\s*```/.test(l)) {
						inFence = !inFence;
						return l;
					}
					if (inFence) return l; // keep syntax highlighting
					// list items: wrap only the text after the marker so the
					// markdown list structure survives
					const m = l.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/);
					if (m && m[2]!.trim() !== "") return `${m[1]}${WHITE}${m[2]}${RESET}`;
					return plainLine(l) ? `${WHITE}${l}${RESET}` : l;
				})
				.join("\n");
		}
		if (messageType !== "user") return markdown;
		const bg = "\x1b[48;2;55;55;55m"; // CC userMessageBackground rgb(55,55,55)
		const bgOff = "\x1b[49m";
		const width = Math.max(1, Math.floor(availableWidth ?? 80));
		// Pad with NBSPs: plain trailing spaces get trimmed by the markdown
		// renderer, NBSPs survive, so the bar spans the full row.
		return markdown
			.split("\n")
			.map((line, i) => {
				const text = `${WHITE}${line}${RESET}`;
				const content = i === 0 ? `${gray("❯")} ${text}` : `  ${text}`;
				const pad = "\u00A0".repeat(Math.max(0, width - visibleWidth(content) - 1));
				return `${bg}${content}${pad}${bgOff}`;
			})
			.join("\n");
	});
}
