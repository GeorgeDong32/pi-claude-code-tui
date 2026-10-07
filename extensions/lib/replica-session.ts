/**
 * ReplicaSession (spec 2026-10-07 P2-1): the hidden lifecycle controller of
 * the CC replica, extracted from the entry factory.
 *
 * The entry used to hold ~19 mutable closure variables shared by enable /
 * disable, 9 event handlers, 5 commands and 3 widget render closures — the
 * exact spot every 2026-10-07 lifecycle bug lived in, with zero automated
 * coverage. This class OWNS that state and the setup/teardown order; the
 * entry keeps only load-time registrations (renderer resolver, entry
 * renderer, markdown transformer, commands) and event ROUTING.
 *
 * Internal rules (spec §4.2):
 * - enable: non-TUI returns immediately (P0-1 N1). Order: presence (core-bus
 *   activate) → model info → tool-row decision → bridge start → patches →
 *   header → editor → footer mode → working → thinking tip → statusline. A
 *   mid-enable failure rolls back every acquired resource (including the
 *   presence) and leaves the session retryable — never enabled with half
 *   the UI.
 * - disable and shutdown share the private release; disable additionally
 *   restores the UI slots (shutdown lets the next session re-own them).
 * - Every session/enable switch bumps a generation; the footer requeue
 *   macrotask and all late callbacks check it.
 * - render delegates are wholly try/caught; last-good frames truncate to
 *   the CURRENT width, with a safe degrade when none exists.
 * - The module holds the WRITE rights; getters expose read-only
 *   projections only.
 *
 * Rendering output is byte-identical to the pre-extraction entry (pure
 * move; golden suites unchanged).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { BUILTIN_SEVEN } from "./takeover-rules.ts";
import { thinkingToggleHint } from "./cc-rows.ts";
import { buildStatusRightGroup, permissionModeLabel, statusRowLayout, stripDuplicateStats } from "./cc-status-line.ts";
import type { PmStatus } from "./pm-capability.ts";
import { readEffortLevel } from "./host-status.ts";
import { RunStateMachine } from "./run-state.ts";
import { CodexStyleEditor, cursorOpenFromFgAnsi, setEditorAccentOpen } from "./claude-tui-editor.ts";
import { silenceNativeCompactionIndicator, type ThemeFg } from "./cc-compaction-row.ts";
import { buildStatuslineJson, composeFooterLines, StatuslineRunner } from "./statusline.ts";
import { DEFAULT_STATUSLINE_SCRIPT } from "./statusline-default-script.ts";
import { buildCompletionLine, effortBadgeSymbol, formatDuration, formatModelLabel, formatTokens } from "./format.ts";
import { PiStartupHeader, type HeaderDataGetters } from "./pi-startup-header.ts";
import { UsageTracker, selectDisplayUsage, type DisplayUsage, type UsageObservationPoint } from "./status-snapshot.ts";
import type { CoreBusClient, CoreUsageLike } from "./core-bus.ts";
import { loadPrefs, resolveStatusLinePrefs, savePrefs, type StatusLinePrefs } from "./prefs.ts";
import { SPINNER_TICK_MS, glimmerIndexAt, shimmerSegments } from "./spinner-shimmer.ts";

// ── injected surfaces ───────────────────────────────────────────────────────

/** Narrow duck type of ctx.ui — never a savable full ctx (spec §4.1). */
export interface UiSlots {
	mode: string;
	notify(message: string, level: string): void;
	setHeader(factory: unknown): void;
	setTitle(title: string): void;
	setEditorComponent(factory: unknown): void;
	setWidget(key: string, content: unknown, options?: { placement?: string }): void;
	setFooter(factory: unknown): void;
	setWorkingVisible?(visible: boolean): void;
	setHiddenThinkingLabel?(label?: string): void;
	setWorkingIndicator(...args: unknown[]): void;
	setWorkingMessage(...args: unknown[]): void;
	theme?: { fg(color: string, s: string): string; bold(s: string): string };
	/** Session data the replica reads at enable/event time (adapted from ctx). */
	model?: { name?: string; id?: string; provider?: string; contextWindow?: number };
	cwd?: string;
	branch?(): unknown[];
	sessionId?(): string | null;
}

/** Derive UiSlots from a host context; a fresh object per call — never stored raw. */
export type UiSlotsOf = (ctx: unknown) => UiSlots;

export interface SessionPiSubset {
	getCommands(): Array<{ name: string }>;
	getAllTools(): Array<{ name: string; sourceInfo?: { source?: string } }>;
	getThinkingLevel?(): string;
}

export interface SessionBridge {
	start(sessionId: string | null): void;
	stop(): void;
}

export interface SessionPatches {
	/** Apply the three prototype patches (compaction / skill / user-bar). */
	applyAll(getFg: () => ThemeFg | null): void;
	restoreAll(): void;
}

export interface ReplicaSessionDeps {
	pi: SessionPiSubset;
	uiOf: UiSlotsOf;
	/** Core-bus client (P0-2): activate at enable, retry at session/render points, close at teardown. */
	coreBus: CoreBusClient;
	/** Obs adapter handle for the session_start branch scan (P0-2/B5). */
	obsAdapter: { resetSeenFromBranch(branch: readonly unknown[]): void };
	bridge: SessionBridge;
	patches: SessionPatches;
	/** prefs file path (read-modify-write store, lib/prefs.ts). */
	prefsPath: string;
	/** Statusline runner factory (tests inject a fake; default spawns bash). */
	statuslineFactory?: (command: string) => StatuslineRunner;
	/** Pure read of the pm status chain (injectable; default = readPmStatus). */
	readPmStatus?: () => PmStatus;
	/** P1-2 step 2: validated read of the structured usage channel (core P2-4). */
	readCoreUsage?: () => CoreUsageLike | null;
	/** True when the user already picked a thinking-collapse preference (tip gate). */
	thinkingPrefExplicit?: () => boolean;
	/** Presence probe → silence pi's native compaction indicator (D6: skipped in native footer mode). */
	silenceIndicator?: (root: unknown) => boolean;
	/** Clock/timer injections for the run state machine (tests step time). */
	now?: () => number;
	setTick?: (fn: () => void, ms: number) => { unref?(): void };
	clearTick?: (handle: unknown) => void;
	/** Verb samplers (injected for determinism). */
	pickRunVerb?: () => string;
	pickCompletionVerb?: () => string;
}

type SessionState = "inactive" | "enabling" | "active" | "disposing";

const CLAUDE_DIM = "\x1b[38;2;153;153;153m";
const CLAUDE_WARNING = "\x1b[38;2;255;204;0m";
const CLAUDE_PLAN = "\x1b[38;2;102;153;153m";
const RESET = "\x1b[39m";

const gray = (s: string) => `${CLAUDE_DIM}${s}${RESET}`;
const yellow = (s: string) => `${CLAUDE_WARNING}${s}${RESET}`;
const teal = (s: string) => `${CLAUDE_PLAN}${s}${RESET}`;

// Mode paint for the permission-modes footer chip (module-level: the footer
// closure rebuilt this table on every frame — plan A7).
const PM_MODE_PAINT: Record<string, (s: string) => string> = {
	ask: gray,
	plan: teal,
	auto: yellow,
	bypass: (s) => `\x1b[38;2;255;102;102m${s}${RESET}`,
};

// --- Spinner frames (CC Spinner utils getDefaultCharacters) ---
const BLOSSOM = ["·", "✢", "✱", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...BLOSSOM, ...[...BLOSSOM].reverse()];

// Past-tense verbs for turn completion (CC turnCompletionVerbs).
const TURN_COMPLETION_VERBS = [
	"Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Worked",
];

const randomOf = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

export class ReplicaSession {
	// ── the mutable state fields (write rights live HERE; the entry keeps none) ──
	private sessionState: SessionState = "inactive";
	private enabled = false;
	private channelActive = false;
	private toolRowsPref: boolean | undefined;
	private statusLinePrefs: StatusLinePrefs;
	private toolRowsEnabled = true;
	private autoYieldNotified = false;
	private thinkingTipShown = false;
	private currentModelName = "";
	private currentProviderName = "";
	private currentContextWindow = 0;
	private headerModelLabel = "Default model";
	private headerCwd = process.cwd();
	private activeEditor: CodexStyleEditor | null = null;
	private dockTui: { requestRender: (force?: boolean) => void } | null = null;
	private spinnerPaint: (s: string) => string = (s) => s;
	private statuslineRunner: StatuslineRunner | null = null;
	private statuslineWidth = 0;
	private showNativeFooter = false;
	private accentOpenAnsi = "\x1b[38;2;138;190;183m"; // sage fallback (#8ABEB7)
	private themeFg: ((color: string, text: string) => string) | null = null;
	private ui: UiSlots | null = null;
	private sessionGeneration = 0;
	private footerRequeueTimer: ReturnType<typeof setTimeout> | null = null;
	private activeHeader: PiStartupHeader | undefined;
	private lastGoodStatusRows: string[] | null = null;
	private lastGoodFooterRows: string[] | null = null;

	private readonly runState: RunStateMachine;
	private readonly usageTracker = new UsageTracker();
	private readonly deps: Required<Pick<ReplicaSessionDeps, "readPmStatus" | "silenceIndicator" | "readCoreUsage">> & ReplicaSessionDeps;
	private lastSeenCoreUsage: CoreUsageLike | null = null;

	constructor(deps: ReplicaSessionDeps) {
		this.deps = {
			readPmStatus: () => ({ workingStats: "", mode: "" }),
			silenceIndicator: silenceNativeCompactionIndicator,
			readCoreUsage: () => null,
			...deps,
		};
		const initial = loadPrefs(deps.prefsPath);
		this.toolRowsPref = initial.toolRows === true || initial.toolRows === false ? initial.toolRows : undefined;
		this.statusLinePrefs = resolveStatusLinePrefs(initial.statusLine);
		this.toolRowsEnabled = this.toolRowsPref !== false && process.env.CC_TUI_TOOL_ROWS !== "0";
		this.runState = new RunStateMachine({
			now: () => (deps.now ? deps.now() : Date.now()),
			// Timers must unref() (AGENTS trap 11).
			setTick:
				deps.setTick ??
				((fn: () => void, ms: number) => {
					const h = setInterval(fn, ms);
					h.unref?.();
					return h as never;
				}),
			clearTick: deps.clearTick ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)),
			tickMs: SPINNER_TICK_MS,
			requestRender: () => this.dockTui?.requestRender(),
			isEnabled: () => this.enabled,
			pickRunVerb: deps.pickRunVerb ?? ((): string => "Working"),
			pickCompletionVerb: deps.pickCompletionVerb ?? (() => randomOf(TURN_COMPLETION_VERBS)),
			completionLine: buildCompletionLine,
		});
	}

	// ── read-only projections (resolver / commands / tests) ───────────────

	toolRowsDecisionInput(): { channelActive: boolean; toolRowsEnabled: boolean; forced: boolean } {
		return { channelActive: this.channelActive, toolRowsEnabled: this.toolRowsEnabled, forced: this.toolRowsPref === true };
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	footerMode(): boolean {
		return this.showNativeFooter;
	}

	rerollVerb(): string {
		return this.runState.rerollVerb();
	}

	lifecycleState(): SessionState {
		return this.sessionState;
	}

	/** Best-effort repaint through the current dock (footer channel hook). */
	requestRender(): void {
		try {
			this.dockTui?.requestRender();
		} catch {
			/* stale dock */
		}
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	enable(ctx: unknown): void {
		const ui = this.deps.uiOf(ctx);
		if (ui.mode !== "tui") return; // P0-1 TUI-03: print/RPC stay stock
		// A fresh session_start while a previous context is still live:
		// release it first so nothing leaks across sessions.
		if (this.enabled) this.release(ui);
		this.ui = ui;
		try {
			this.setup(ui);
		} catch (error) {
			// Never enabled with half the UI: roll back everything acquired
			// (including the presence) and stay retryable. Loud, like the
			// other register-time guards — a permanently failing enable must
			// not be invisible.
			const reason = (error as Error | null | undefined)?.message ?? String(error);
			console.warn(`[claude-tui] enable failed and rolled back: ${reason}`);
			try {
				this.release(ui);
			} catch {
				/* rollback containment */
			}
		}
	}

	disable(ctx: unknown): void {
		const ui = this.deps.uiOf(ctx);
		this.release(ui);
		if (ui.mode !== "tui") return;
		// UI slot restore (N2): shutdown skips this — the next session's
		// enable re-owns the slots.
		this.slot(ui, "working-visible", (s) => s.setWorkingVisible?.(true));
		this.slot(ui, "thinking-label", (s) => s.setHiddenThinkingLabel?.());
		this.slot(ui, "editor-component", (s) => s.setEditorComponent(undefined));
		// Replica fully off: relinquish the footer slot (restores pi's
		// built-in footer). Single-occupancy caveat applies, but an explicit
		// off means the user wants stock pi back.
		this.slot(ui, "footer-slot", (s) => s.setFooter(undefined));
		this.slot(ui, "cc-status-widget", (s) => s.setWidget("cc-status", undefined));
		this.slot(ui, "cc-footer-widget", (s) => s.setWidget("cc-footer", undefined));
		this.slot(ui, "working-indicator", (s) => s.setWorkingIndicator());
		this.slot(ui, "working-message", (s) => s.setWorkingMessage());
	}

	shutdown(ctx: unknown): void {
		const ui = this.deps.uiOf(ctx);
		this.release(ui);
		if (ui.mode !== "tui") return;
		this.slot(ui, "working-indicator", (s) => s.setWorkingIndicator());
		this.slot(ui, "editor-component", (s) => s.setEditorComponent(undefined));
	}

	private setup(ui: UiSlots): void {
		this.enabled = true;
		this.sessionState = "enabling"; // transient — setup is synchronous
		// P0-2: presence declaration + handoff baseline + subscription in one
		// synchronous segment (retry points keep it fresh afterwards).
		this.deps.coreBus.activate();
		this.cacheAccentAnsi(ui);
		const model = ui.model;
		this.currentModelName = model?.name || model?.id || "";
		this.currentProviderName = model?.provider || "";
		this.currentContextWindow = model?.contextWindow || 0;
		this.headerModelLabel = formatModelLabel(model as never);
		this.headerCwd = ui.cwd ?? process.cwd();
		this.resolveToolRows(ui);
		this.channelActive = true; // TUI session active (non-TUI returned above)
		// Presentation seam: probe → register (or re-register on late hosts).
		this.slot(ui, "subagent-bridge", () => this.deps.bridge.start(ui.sessionId?.() ?? null));
		this.deps.patches.applyAll(() => this.themeFg);
		this.applyHeader(ui);
		this.setEditor(ui);
		this.applyFooterMode(ui);
		this.applyWorking(ui);
		this.applyThinkingLook(ui);
		// Idempotent: re-create the statusline runner after off→on (release
		// tore it down). Skip the initial refresh until a render supplied the
		// real terminal width — the widget's width-diff check triggers the
		// first run.
		this.ensureStatuslineRunner();
		if (this.statuslineWidth > 0) this.refreshStatusline();
		this.sessionState = "active";
	}

	/** Shared release (P0-1 §4.2 order; P0-2 folded obs+presence into the client close). */
	private release(ui: UiSlots): void {
		// Already released (double disable/shutdown): nothing left to do —
		// the client's own close is idempotent, but no reason to re-run the
		// step sequence against slots that may belong to a newer session.
		if (!this.enabled && this.sessionState === "inactive" && !this.footerRequeueTimer) return;
		// Gate re-entrant setup FIRST: generation invalidates every late
		// callback (footer requeue, bridge handshakes) from this session.
		this.enabled = false;
		this.channelActive = false;
		this.sessionState = "disposing";
		this.sessionGeneration++;
		if (this.footerRequeueTimer) {
			clearTimeout(this.footerRequeueTimer);
			this.footerRequeueTimer = null;
		}
		this.slot(ui, "subagent-bridge", () => this.deps.bridge.stop());
		// P0-2: one close unsubscribes the three channels, detaches the
		// adapters and withdraws OUR presence object — between shutdown and
		// the next session_start, core's fallback owns display again.
		this.slot(ui, "core-bus-client", () => this.deps.coreBus.close());
		this.slot(ui, "statusline", () => this.teardownStatusline());
		this.slot(ui, "run-state", () => this.runState.halt());
		this.slot(ui, "editor", () => {
			this.activeEditor?.release();
			this.activeEditor = null;
		});
		this.slot(ui, "header", () => {
			this.activeHeader?.dispose();
			this.activeHeader = undefined;
			if (ui.mode === "tui") ui.setHeader(undefined);
		});
		this.slot(ui, "patches", () => this.deps.patches.restoreAll());
		// Drop stale session references so a late closure cannot reach a
		// replaced session.
		this.slot(ui, "stale-refs", () => {
			this.ui = null;
			this.dockTui = null;
			this.lastGoodStatusRows = null;
			this.lastGoodFooterRows = null;
			this.headerModelLabel = "Default model";
			this.headerCwd = process.cwd();
		});
		this.sessionState = "inactive";
	}

	/** Individually contained slot step: one throw never blocks the rest (P0-1 §4.2). */
	private slot(ui: UiSlots, label: string, fn: (slots: UiSlots) => void): void {
		try {
			fn(ui);
		} catch {
			void label; // a failing step never blocks the rest
		}
	}

	// ── event adapters (the entry routes host events here) ────────────────

	onSessionStart(ctx: unknown): void {
		const ui = this.deps.uiOf(ctx);
		if (ui.mode !== "tui") return;
		this.observeUsage(ui);
		this.enable(ctx);
		// P0-2: rebuild the per-session obs dedupe from the branch's persisted
		// packed entries (reload/resume) — AFTER enable so a re-enable's
		// onDetach wipe cannot discard the scan; the attach baseline union
		// already covers the snapshot's current sites.
		this.slot(ui, "obs-branch-scan", () => this.deps.obsAdapter.resetSeenFromBranch(ui.branch?.() ?? []));
		// Contained: a throwing store getter / register must never reach the
		// host's session_start dispatch (P0-2 §4.1).
		this.slot(ui, "core-bus-retry", () => void this.deps.coreBus.retry());
	}

	/** Usage observation points (spec 8.2 sampling stays in the tracker). */
	onUsagePoint(point: UsageObservationPoint, ctx: unknown): void {
		if (!this.enabled) return;
		this.observeUsage(this.deps.uiOf(ctx));
		if (point !== "session_start") this.refreshStatusline();
	}

	onModelSelect(model: { name?: string; id?: string; provider?: string; contextWindow?: number } | null | undefined): void {
		if (!this.enabled) return;
		this.currentModelName = model?.name || model?.id || "";
		this.currentProviderName = model?.provider || "";
		this.currentContextWindow = model?.contextWindow || 0;
		this.headerModelLabel = formatModelLabel(model as never);
		this.refreshStatusline();
	}

	onRunStart(ctx: unknown): void {
		if (!this.enabled) return;
		const ui = this.deps.uiOf(ctx);
		this.spinnerPaint = this.accentFg(ui);
		this.runState.startRun();
	}

	onRunSettled(ctx: unknown): void {
		if (!this.enabled) return;
		this.runState.endRun();
		// Post-append guarantee (spec 8.2): the final assistant message is
		// in the branch by the time the run settles.
		this.onUsagePoint("agent_settled", ctx);
	}

	onCompactionStart(ctx: unknown): void {
		if (!this.enabled) return;
		const ui = this.deps.uiOf(ctx);
		this.refreshStatusline();
		this.spinnerPaint = this.accentFg(ui);
		this.runState.startCompaction();
		// pi shows its native indicator row before this event fires; mute it
		// so compaction lives only on the cc-status spinner line. P3-1 D6:
		// in native footer mode cc-status (and dockTui) is unmounted — the
		// retries can only spin, so skip the hush entirely.
		if (this.showNativeFooter) return;
		const hush = (retries: number): void => {
			if (this.deps.silenceIndicator(this.dockTui)) return;
			if (retries <= 0) return;
			const t = setTimeout(() => hush(retries - 1), 100);
			t.unref?.();
		};
		hush(4);
	}

	onCompactionEnd(ctx: unknown): void {
		// Compaction state must clear even when the end event lands while
		// disabled/shutdown (review P2-1 finding 1: the enabled gate left
		// "Compacting context…" stuck across an off→on cycle — run-state
		// gates nothing here in the old entry either).
		this.runState.stopCompaction();
		if (!this.enabled) return;
		this.onUsagePoint("session_compact", ctx);
	}

	onCompactionFailed(): void {
		this.runState.stopCompaction();
	}

	/** Core notification display sink (P0-2 adapter target). */
	displayNotification = (msg: string, level: string): void => {
		try {
			this.ui?.notify(msg, level as "info" | "warning" | "error");
		} catch {
			// stale slots — drop this one
		}
	};

	/** Core footer rows (P0-2/B6) — wired by the entry to the footer channel. */
	coreFooterLines: () => readonly string[] = () => [];

	// ── commands ───────────────────────────────────────────────────────────

	/** /claude-tui toggle; returns the new enabled state. */
	toggle(ctx: unknown): boolean {
		if (this.enabled) {
			this.disable(ctx);
			return false;
		}
		this.enable(ctx);
		return this.isEnabled(); // enable no-ops in non-TUI mode
	}

	/** /claude-tools on|off|auto; returns the user message. */
	setToolRows(args: string, ctx: unknown): string {
		void ctx;
		const a = args.trim().toLowerCase();
		if (a === "auto" || (a !== "on" && a !== "off" && this.toolRowsPref === undefined)) {
			this.toolRowsPref = undefined;
			savePrefs({ toolRows: undefined }, this.deps.prefsPath);
			const owner = this.externalToolOwner();
			this.toolRowsEnabled = !owner;
			if (owner) return `CC tool rows auto-off — tools owned by ${owner} (run /claude-tools on to override)`;
			return "CC tool rows auto-on — no other owner detected";
		}
		const next = a === "on" ? true : a === "off" ? false : !this.toolRowsEnabled;
		this.toolRowsPref = next;
		this.toolRowsEnabled = next;
		savePrefs({ toolRows: next }, this.deps.prefsPath);
		return next
			? "CC tool rows on — every new tool call renders as CC rows (other renderers yield; execute untouched)"
			: "CC tool rows off — new tool calls render stock (another TUI extension, if any, takes over immediately)";
	}

	/** /claude-footer [on|off]; returns the effective mode. */
	setFooterModeFromCommand(args: string, ctx: unknown): { native: boolean } {
		const a = args.trim().toLowerCase();
		if (a === "on" || a === "off") this.showNativeFooter = a === "on";
		else this.showNativeFooter = !this.showNativeFooter;
		if (this.enabled) this.applyFooterMode(this.deps.uiOf(ctx));
		return { native: this.showNativeFooter };
	}

	/** /claude-statusline …; returns the user message, or null for usage. */
	setStatusline(args: string, ctx: unknown): string | null {
		const a = args.trim();
		const badgeMatch = a.match(/^badge\s+(on|off)$/i);
		const setMatch = a.match(/^set\s+(.+)$/i);
		if (badgeMatch) {
			this.statusLinePrefs = { ...this.statusLinePrefs, badge: badgeMatch[1]!.toLowerCase() === "on" };
		} else if (setMatch) {
			// `set` implies on — setting a script is an intent to use it;
			// saving it dark confused users ("set 之后没反应").
			this.statusLinePrefs = { ...this.statusLinePrefs, command: setMatch[1]!.trim(), enabled: true };
			this.teardownStatusline(); // recreate with the new command
		} else if (a === "" || a === "on" || a === "off") {
			this.statusLinePrefs = {
				...this.statusLinePrefs,
				enabled: a === "" ? !this.statusLinePrefs.enabled : a === "on",
			};
			if (!this.statusLinePrefs.enabled) this.teardownStatusline();
		} else {
			return null; // usage
		}
		savePrefs({ statusLine: this.statusLinePrefs }, this.deps.prefsPath);
		if (this.enabled) {
			this.ensureStatuslineRunner();
			this.refreshStatusline();
			this.applyFooterMode(this.deps.uiOf(ctx));
		}
		return `Statusline ${this.statusLinePrefs.enabled ? "on" : "off"}${badgeMatch ? ` — badge ${this.statusLinePrefs.badge ? "on" : "off"}` : ""}${setMatch ? ` — command: ${this.statusLinePrefs.command}` : ""}`;
	}

	// ── UI application (order pinned by spec §4.2) ─────────────────────────

	private applyHeader(ui: UiSlots): void {
		if (ui.mode !== "tui") return;
		ui.setTitle("Pi");
		const getters: HeaderDataGetters = {
			modelLabel: () => this.headerModelLabel,
			cwd: () => this.headerCwd,
		};
		ui.setHeader((tui: unknown, theme: unknown) => {
			const header = new PiStartupHeader(this.deps.pi as never, tui as never, theme as never, getters);
			this.activeHeader = header;
			return header;
		});
	}

	private setEditor(ui: UiSlots): void {
		ui.setEditorComponent((tui: unknown, theme: unknown, keybindings: unknown) => {
			// NOTE: the factory body runs synchronously inside
			// setEditorComponent (slots live), but cursorOpen fires on every
			// editor render — it must not touch captured slots (stale after
			// session replace → uncaught throw kills pi). Replacing the
			// editor releases the old instance's blink timer (spec 8.1).
			this.activeEditor?.release();
			this.activeEditor = new CodexStyleEditor(tui as never, theme as never, keybindings as never, () =>
				cursorOpenFromFgAnsi(this.accentOpenAnsi),
			);
			return this.activeEditor;
		});
	}

	private applyFooterMode(ui: UiSlots): void {
		if (ui.mode !== "tui") return;
		if (this.showNativeFooter) {
			ui.setFooter(undefined); // restore built-in footer
			ui.setWidget("cc-status", undefined);
			// Plan SL4/D2: script rows first, mode/hints below them.
			this.setFooterLine(ui, true);
		} else {
			this.setFooterBlankLine(ui);
			// Mode/hints join the cc-footer widget so they render ABOVE the
			// fleet roster (registered lazily by pi-subagents at first active
			// run → map tail).
			this.setFooterLine(ui, true);
			this.setStatusWidget(ui);
			// aboveEditor widgets render in registration order, and this
			// enable() runs in cctui's session_start — before later-loaded
			// extensions (e.g. core's goal block) mount theirs. Re-register
			// on the next macrotask: same-key setWidget re-inserts at the map
			// tail, so cc-status (spinner) stays closest to the editor. A
			// microtask is NOT enough — the extension runner's per-handler
			// awaits flush the microtask queue before the next extension's
			// session_start runs.
			// Best-effort ordering only — a macrotask is not guaranteed to
			// land after every async handler or a later widget update
			// (XPKG-09-HOST); the callback re-checks the generation and the
			// footer mode so a stale fire cannot reinstall a dead widget.
			const requeueGeneration = this.sessionGeneration;
			if (this.footerRequeueTimer) clearTimeout(this.footerRequeueTimer);
			const requeue = setTimeout(() => {
				this.footerRequeueTimer = null;
				if (this.enabled && this.sessionGeneration === requeueGeneration && !this.showNativeFooter && this.ui) {
					this.setStatusWidget(this.ui);
				}
			}, 0);
			requeue.unref?.();
			this.footerRequeueTimer = requeue;
		}
	}

	private applyWorking(ui: UiSlots): void {
		this.spinnerPaint = this.accentFg(ui);
		// pi 0.85+ exposes setWorkingVisible to hide its built-in loader row.
		try {
			ui.setWorkingVisible?.(false);
		} catch {
			// older pi without the API: default row stays (best effort)
		}
	}

	private applyThinkingLook(ui: UiSlots): void {
		try {
			ui.setHiddenThinkingLabel?.(`✻ Thinking… (${thinkingToggleHint()} to expand)`);
		} catch {
			// stale slots or older pi — label stays default
		}
		if (!this.thinkingTipShown && !(this.deps.thinkingPrefExplicit?.() ?? true)) {
			this.thinkingTipShown = true;
			ui.notify(`Tip: ${thinkingToggleHint()} toggles collapsed thinking blocks (saved to settings.json)`, "info");
		}
	}

	// ── cc-status widget render (byte-identical move from the entry) ──────

	private setStatusWidget(ui: UiSlots): void {
		ui.setWidget("cc-status", (tui: unknown, theme: unknown) => ({
			invalidate() {},
			render: (width: number): string[] => this.renderStatusRow(width, theme as never, tui as never),
		}));
	}

	renderStatusRow(
		width: number,
		theme: { fg(c: string, s: string): string; bold(s: string): string },
		tui: unknown,
	): string[] {
		try {
			const rows = this.statusRows(width, theme, tui);
			this.lastGoodStatusRows = rows;
			return rows;
		} catch {
			// AGENTS trap 1: render must never throw — degrade to the
			// last-good frame truncated to the CURRENT width.
			if (this.lastGoodStatusRows && this.lastGoodStatusRows.length > 0) {
				return this.lastGoodStatusRows.map((line) => truncateToWidth(line, width, ""));
			}
			return [];
		}
	}

	private statusRows(width: number, theme: { fg(c: string, s: string): string; bold(s: string): string }, tui: unknown): string[] {
		this.dockTui = tui as { requestRender: (force?: boolean) => void } | null;
		// P0-2: per-frame retry point (O(1) when attached — one identity
		// comparison; re-attaches after a bus change).
		this.deps.coreBus.retry();
		const modelName = this.currentModelName || "no model";
		const sep = theme.fg("dim", "│");

		const muted = (s: string) => theme.fg("muted", s);

		// P1-2: cost / ctx% shows exactly once. With the STRUCTURED channel
		// (core P2-4+) the left side formats its own ↑/↓/R/⚡ from raw
		// numbers — no $/%ctx ever enters it, so no stripping is needed.
		// The old-core string path keeps the holder matrix: script row with
		// valid output owns the numbers; otherwise (off / waiting / empty /
		// persistent error) the right group is the fallback holder, and the
		// core string drops its duplicated numeric segments ONLY then.
		const display = this.displayUsage();
		const runnerLines = this.statuslineRunner ? this.statuslineRunner.getRenderLines() : [];
		const scriptHasOutput =
			this.statusLinePrefs.enabled && !(this.statuslineRunner?.hasPersistentError() ?? false) && runnerLines.length > 0;
		const rightOwnsNumbers = !scriptHasOutput;
		const rightShowsNumbers = display.cost > 0 || display.usedPercent !== null;
		let pmStats: string;
		if (display.structured) {
			const parts = [`↑${formatTokens(display.structured.input)}`, `↓${formatTokens(display.structured.output)}`];
			if (display.structured.cacheRead > 0) parts.push(`R${formatTokens(display.structured.cacheRead)}`);
			if (display.structured.tps > 0) parts.push(`⚡${Math.round(display.structured.tps)} tok/s`);
			pmStats = parts.join(" · ");
		} else {
			const pmStatsRaw = this.deps.readPmStatus().workingStats;
			pmStats = scriptHasOutput || rightShowsNumbers ? stripDuplicateStats(pmStatsRaw) : pmStatsRaw;
		}
		// Shimmer sweep (CC Spinner.tsx): the per-run verb is static; a narrow
		// claudeShimmer band rides the 200ms tick across the word.
		const now = this.deps.now?.() ?? Date.now();
		const rv = this.runState.view();
		const verbText = `${rv.verb}…`;
		const seg = shimmerSegments(verbText, glimmerIndexAt(now - rv.runStart, visibleWidth(verbText)));
		const verbPainted =
			(seg.before ? this.spinnerPaint(seg.before) : "") +
			(seg.shimmer ? theme.fg("borderAccent", seg.shimmer) : "") +
			(seg.after ? this.spinnerPaint(seg.after) : "");
		const left = rv.compacting
			? `${this.spinnerPaint(SPINNER_FRAMES[rv.spinnerIdx % SPINNER_FRAMES.length]!)} ${this.spinnerPaint("Compacting context…")} ${theme.fg("dim", "(esc to cancel)")}`
			: rv.running
				? `${this.spinnerPaint(SPINNER_FRAMES[rv.spinnerIdx % SPINNER_FRAMES.length]!)} ${verbPainted} ${theme.fg("dim", `(${formatDuration(now - rv.runStart)} · esc to interrupt)`)}${pmStats ? ` ${theme.fg("dim", pmStats)}` : ""}`
				: rv.lastWorkedLine
					? theme.fg("dim", rv.lastWorkedLine)
					: "";
		// Plan SL4/D4: with the statusline's script row live, model/effort/
		// ctx/cost live on the script row + right-aligned badge instead — the
		// right group collapses so the same info never shows twice. P1-2:
		// while the script has NO valid output the right group is the
		// fallback holder, so the numbers never vanish.
		const right = !rightOwnsNumbers
			? ""
			: buildStatusRightGroup({
					model: modelName,
					effort: readEffortLevel(this.deps.pi as never),
					used: display.usedTokens ?? 0,
					contextWindow: display.contextWindow,
					cost: display.cost,
					pct: display.usedPercent,
					muted,
					dim: (t) => theme.fg("dim", t),
					sep,
				});
		// Left/right join lives in lib/cc-status-line.ts (table-tested).
		return statusRowLayout(left, right, width);
	}

	// ── cc-footer widget render (byte-identical move from the entry) ──────

	private setFooterLine(ui: UiSlots, includeHints: boolean): void {
		ui.setWidget(
			"cc-footer",
			(_tui: unknown, theme: unknown) => ({
				invalidate() {},
				render: (width: number): string[] => this.renderFooterRows(width, theme as never, includeHints),
			}),
			{ placement: "belowEditor" },
		);
	}

	renderFooterRows(
		width: number,
		theme: { fg(c: string, s: string): string; bold(s: string): string },
		includeHints: boolean,
	): string[] {
		try {
			const rows = this.footerRows(width, theme, includeHints);
			this.lastGoodFooterRows = rows;
			return rows;
		} catch {
			if (this.lastGoodFooterRows && this.lastGoodFooterRows.length > 0) {
				return this.lastGoodFooterRows.map((line) => truncateToWidth(line, width, ""));
			}
			return [""]; // the widget always yields a row
		}
	}

	private footerRows(width: number, theme: { fg(c: string, s: string): string; bold(s: string): string }, includeHints: boolean): string[] {
		// P0-2/C8: this render is the retry point that stays alive in
		// native-footer mode (cc-status is unmounted there) — no timers, no
		// polling; O(1) while attached.
		this.deps.coreBus.retry();
		// Width changes re-run the script (its layout usually depends on
		// OVERRIDE_TERM_WIDTH); request() debounces and dedups, so this
		// per-frame call only acts on actual changes.
		if (width !== this.statuslineWidth) {
			this.statuslineWidth = width;
			this.refreshStatusline();
		}
		// P0-2/B6: core's display.footer rows render as independent dim rows
		// AFTER the script rows and BEFORE the hints line — absent channel
		// keeps the historical output byte-identical.
		const coreFooter = this.coreFooterLines().map((line) => theme.fg("dim", line));
		return composeFooterLines({
			statuslineOn: this.statusLinePrefs.enabled,
			badgeOn: this.statusLinePrefs.badge,
			lines: this.statuslineRunner ? this.statuslineRunner.getRenderLines() : [],
			coreFooter,
			badgeText: (() => {
				if (!this.statusLinePrefs.badge) return "";
				// CC-style effort chip (`● high · /effort`): effort only —
				// the script row already names the model.
				const effort = readEffortLevel(this.deps.pi as never);
				return effort && effort !== "off" ? `${effortBadgeSymbol(effort)} ${effort} · /effort` : "";
			})(),
			badgePaint: (s) => theme.fg("muted", s),
			hints: includeHints ? this.footerLineText((s) => theme.fg("dim", s), width) : "",
			width,
		});
	}

	/** Footer-slot blank filler (native-off mode; keeps the dock row well-formed on old pi). */
	private setFooterBlankLine(ui: UiSlots): void {
		ui.setFooter(() => ({
			invalidate() {},
			render(_width: number): string[] {
				return [];
			},
		}));
	}

	private footerLineText(fgDim: (s: string) => string, width: number): string {
		// pi-permission-modes publishes its live mode into this env var on
		// every setMode, so reading it at render time always reflects the
		// current mode, styled with that extension's own icon/label
		// semantics.
		const status = this.deps.readPmStatus();
		const label = permissionModeLabel(
			status.mode || process.env.PERMISSION_MODES_INHERITED_MODE?.trim(),
			status.meta,
			(mode) => PM_MODE_PAINT[mode] ?? gray,
			gray,
		);
		// CC behavior: while the input holds text, only the mode label shows.
		if (this.editorHasText()) return truncateToWidth(label, width, "");
		const hints = fgDim("· ! for bash mode · ctrl+p model · ctrl+o tools");
		return truncateToWidth(`${label} ${hints}`, width);
	}

	private editorHasText(): boolean {
		try {
			return (this.activeEditor?.getText() ?? "").trim().length > 0;
		} catch {
			return false;
		}
	}

	// ── statusline runner ──────────────────────────────────────────────────

	private statuslineCommand(): string {
		if (this.statusLinePrefs.command) return this.statusLinePrefs.command;
		// Bundled default: the script SOURCE goes straight to `bash -c` — no
		// filesystem anchor exists (jiti evaluates extensions from data:
		// URLs). See lib/statusline-default-script.ts.
		return DEFAULT_STATUSLINE_SCRIPT;
	}

	private statuslineOn(): boolean {
		return this.enabled && this.statusLinePrefs.enabled;
	}

	private ensureStatuslineRunner(): void {
		if (!this.statuslineOn() || this.statuslineRunner) return;
		this.statuslineRunner = this.deps.statuslineFactory
			? this.deps.statuslineFactory(this.statuslineCommand())
			: new StatuslineRunner({ command: this.statuslineCommand() });
		this.statuslineRunner.setOnUpdate(() => this.dockTui?.requestRender());
	}

	private teardownStatusline(): void {
		this.statuslineRunner?.dispose();
		this.statuslineRunner = null;
	}

	private refreshStatusline(): void {
		if (!this.statuslineRunner) return;
		this.statuslineRunner.request(this.buildStatuslineInput(), this.statuslineWidth || 100);
	}

	private buildStatuslineInput(): string {
		const effort = readEffortLevel(this.deps.pi as never);
		// P1-2 step 2: the JSON reads the SAME display-usage selection as the
		// right group — cost / used% / window / totals come from the selected
		// source; current_usage stays per-request (tracker lastInput/Output —
		// cumulative numbers must not impersonate a single request).
		const display = this.displayUsage();
		const tracker = this.usageTracker.get();
		return buildStatuslineJson(
			{
				...tracker,
				cost: display.cost,
				used: display.usedTokens ?? 0,
				totalInput: display.totalInput,
				totalOutput: display.totalOutput,
			},
			{
				displayName: this.currentModelName || "no model",
				id: this.currentProviderName ? `${this.currentProviderName}/${this.currentModelName || "model"}` : this.currentModelName,
				provider: this.currentProviderName,
			},
			display.contextWindow,
			{ cwd: process.cwd(), effort, usedPercent: display.usedPercent ?? undefined },
		);
	}

	// ── helpers ────────────────────────────────────────────────────────────

	/** The ONE display-usage selection (P1-2 step 2 / U2) — right group and
	 * statusline JSON read the same numbers. */
	private displayUsage(): DisplayUsage {
		return selectDisplayUsage({
			tracker: this.usageTracker.get(),
			core: this.deps.readCoreUsage(),
			hostContextWindow: this.currentContextWindow,
		});
	}

	/**
	 * Bus-snapshot hook (core-bus adapter target): when core publishes a new
	 * usage object (identity change), refresh the statusline input — this
	 * covers the cctui-first load order, where core's message_end publish
	 * lands AFTER this session's own refresh point.
	 */
	onBusSnapshot(): void {
		const usage = this.deps.readCoreUsage();
		if (usage === this.lastSeenCoreUsage) return;
		this.lastSeenCoreUsage = usage;
		if (this.enabled) this.refreshStatusline();
	}

	private observeUsage(ui: UiSlots): void {
		try {
			this.usageTracker.observe((ui.branch?.() ?? []) as never);
		} catch {
			// stale slots: keep the last-good snapshot
		}
	}

	private externalToolOwner(): string | undefined {
		try {
			const tools = this.deps.pi.getAllTools();
			// Who owns the built-in tool rows right now? Returns the owner's
			// source id, or undefined when pi's own built-ins own them.
			for (const name of BUILTIN_SEVEN) {
				const source = tools.find((tool) => tool?.name === name)?.sourceInfo?.source;
				if (typeof source === "string" && source !== "builtin" && !source.includes("claude-code-tui")) return source;
			}
		} catch {
			// getAllTools unavailable before the extension runtime is bound.
		}
		return undefined;
	}

	private resolveToolRows(ui: UiSlots): void {
		// Explicit choice wins; otherwise auto-detect. Detection runs here
		// (not at load) so every extension has registered already. The
		// resolver channel itself is registered at load — here we only
		// resolve the effective switch.
		if (process.env.CC_TUI_TOOL_ROWS === "0" || this.toolRowsPref === false) {
			this.toolRowsEnabled = false;
		} else if (this.toolRowsPref === true) {
			this.toolRowsEnabled = true;
		} else {
			const owner = this.externalToolOwner();
			this.toolRowsEnabled = !owner;
			if (owner && !this.autoYieldNotified) {
				this.autoYieldNotified = true;
				ui.notify(`CC tool rows auto-off — tools owned by ${owner} (run /claude-tools on to override)`, "info");
			}
		}
	}

	private accentFg(ui: UiSlots | null): (s: string) => string {
		try {
			const theme = ui?.theme;
			if (theme?.fg) return (s) => theme.fg("accent", s);
		} catch {
			// stale slots — fall back to unstyled text
		}
		return (s) => s;
	}

	private cacheAccentAnsi(ui: UiSlots): void {
		try {
			const t = ui.theme;
			if (t?.fg) this.themeFg = (c, s) => t.fg(c, s);
			const seq = t?.fg?.("accent", "");
			if (typeof seq === "string" && seq.includes("38;")) {
				this.accentOpenAnsi = seq.slice(0, seq.indexOf("m") + 1);
				setEditorAccentOpen(this.accentOpenAnsi);
			}
		} catch {
			// keep last-good / default sage
		}
	}
}
