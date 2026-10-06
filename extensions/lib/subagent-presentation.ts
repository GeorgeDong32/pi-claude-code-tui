/**
 * Subagent presentation seam — consumer-side mirror of the pi-subagents v1
 * presentation protocol (spec/2026-10-05-cc-tui-subagent-presentation.md §5).
 *
 * This module deliberately mirrors the upstream contract instead of importing
 * it: the runtime install path is not an import surface, jiti module identity
 * is not shared across extensions, and a versioned wire protocol deserves a
 * version-gated mirror on each side (the repo convention for pi internals,
 * cf. pm-capability.ts). When upstream publishes typed entry points, this
 * mirror can shrink to a re-export.
 *
 * Red line: nothing here executes tools, touches schemas, or reads model-
 * visible content. The seam carries read-only display frames in and text
 * layout facts out.
 */

/** Exact major version; mismatches are "unsupported", never best-effort. */
export const SUBAGENT_PRESENTATION_PROTOCOL_VERSION = 1;

export const SUBAGENT_PRESENTATION_READY_EVENT = "pi-subagents:presentation:v1:ready";
export const SUBAGENT_PRESENTATION_PROBE_EVENT = "pi-subagents:presentation:v1:probe";
export const SUBAGENT_PRESENTATION_REGISTER_EVENT = "pi-subagents:presentation:v1:register";
export const SUBAGENT_PRESENTATION_WITHDRAW_EVENT = "pi-subagents:presentation:v1:withdraw";
export const SUBAGENT_PRESENTATION_DIAGNOSTIC_EVENT = "pi-subagents:presentation:v1:diagnostic";

export type SubagentPresentationSurface = "fleet" | "async";

/** Minimal structural mirror of the pi event bus as the seam needs it. */
export interface SubagentPresentationEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Theme the drawing may assume. Drawing must tolerate missing keys. */
export interface SubagentPresentationTheme {
	fg: (name: string, text: string) => string;
	bold?: (text: string) => string;
	getThinkingBorderColor?: (level: string) => (text: string) => string;
}

export interface SubagentPresentationUsage {
	tokens: number;
	window?: number;
}

export interface SubagentPresentationTiming {
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
}

export interface SubagentPresentationWorkflowPreflightHints {
	mode?: string;
	decision?: string;
	claims?: string[];
	expectedOutput?: string;
	independence?: string;
}

export interface SubagentPresentationRowDetails {
	provider?: string;
	role?: string;
	target?: string;
	detail?: string;
	reasonCode?: string;
	freshness?: { stale?: boolean; observedRef?: string };
	reportPath?: string;
}

export interface SubagentPresentationWorkflowLaneRow extends SubagentPresentationTiming, SubagentPresentationRowDetails {
	rowKind: "workflow-lane";
	rowKey: string;
	ownerKey: string;
	branch: "├─" | "└─";
	kind?: string;
	name: string;
	context?: string;
	modelThinking?: string;
	thinking?: string;
	state: string;
	verdict?: string;
	activity?: string;
	preflight?: SubagentPresentationWorkflowPreflightHints;
	usage?: SubagentPresentationUsage;
	overflow?: number;
}

export interface SubagentPresentationWorkflowPhaseRow {
	rowKind: "workflow-phase";
	rowKey: string;
	ownerKey: string;
	branch: "├─" | "└─";
	label: string;
	text: string;
	state: string;
}

export interface SubagentPresentationNestedRow extends SubagentPresentationTiming {
	rowKind: "nested";
	rowKey: string;
	ownerKey: string;
	branch: "├─" | "└─";
	name: string;
	agentIdentity?: string;
	state: string;
	modelThinking?: string;
	thinking?: string;
	activity?: string;
	usage?: SubagentPresentationUsage;
	depth: number;
	overflow?: number;
}

export interface SubagentPresentationAgentRow extends SubagentPresentationTiming {
	rowKind: "agent";
	rowKey: string;
	targetKey?: string;
	parentKey?: string;
	branch?: "├─" | "└─";
	agentIdentity: string;
	label?: string;
	modelThinking?: string;
	state: string;
	usage?: SubagentPresentationUsage;
	workflowWrapperUsageOnChildren?: boolean;
	projectPane?: { summary?: string; refreshedAt: number };
	external?: boolean;
	selected?: boolean;
}

export type SubagentPresentationFleetRow =
	| { rowKind: "main"; rowKey: "main"; selected?: boolean }
	| { rowKind: "overflow"; rowKey: string; direction: "above" | "below"; hidden: number }
	| SubagentPresentationAgentRow
	| SubagentPresentationWorkflowLaneRow
	| SubagentPresentationWorkflowPhaseRow
	| SubagentPresentationNestedRow
	| { rowKind: "section-header"; rowKey: string; text: string };

export interface SubagentPresentationFrameBase {
	protocol: typeof SUBAGENT_PRESENTATION_PROTOCOL_VERSION;
	surface: SubagentPresentationSurface;
	revision: string;
	session: string | null;
	runtimeGeneration: number;
	width: number;
	theme: SubagentPresentationTheme;
	now: number;
}

export interface SubagentPresentationFleetFrame extends SubagentPresentationFrameBase {
	surface: "fleet";
	rows: SubagentPresentationFleetRow[];
	selection: { active: boolean; selectedKey: string | null };
	budget: { visibleRows: number; hiddenAbove: number; hiddenBelow: number; maxRows: number };
	summary: SubagentPresentationFleetSummary;
}

/** Collapsed-summary material for the native fleet roster (CC ignores). */
export interface SubagentPresentationFleetSummary {
	activeLeafAgents: number;
	anyExternal: boolean;
	capacity?: { used: number; limit: number };
	nativeUsage: { tokens: number; window?: number; count: number };
	hasWorkflowWrapper: boolean;
	panes: { total: number; attention: number };
}

// ---- Async surface mirror (spec §4.4) ----

export interface SubagentPresentationAsyncCounts {
	running: number;
	queued: number;
	failed: number;
	stopped: number;
	paused: number;
	partial: number;
	rejected: number;
	complete: number;
	total: number;
}

export interface SubagentPresentationAsyncDetailRow {
	rowKind: "detail";
	rowKey: string;
	text: string;
	gutter: boolean;
	tone: "dim" | "accent" | "plain";
}

export interface SubagentPresentationAsyncJobSection {
	rowKey: string;
	header: {
		name: string;
		title: string;
		state: string;
		context?: string;
		stats?: string;
		activity?: string;
		glyphState: "running" | "queued" | "complete" | "failed" | "partial" | "paused" | "stopped" | "rejected";
		compactWorkflow: boolean;
		singleChildJob: boolean;
		glyph?: string;
		contextBadge?: string;
		identity?: string;
		summaryLine?: string;
		titleLine?: string;
		itemHeadLine?: string;
	};
	rows: Array<SubagentPresentationAsyncDetailRow | SubagentPresentationWorkflowLaneRow | SubagentPresentationWorkflowPhaseRow | SubagentPresentationNestedRow>;
	children: SubagentPresentationAsyncJobSection[];
	childrenLines?: string[];
	childrenHidden?: number;
}

export interface SubagentPresentationAsyncFrame extends SubagentPresentationFrameBase {
	surface: "async";
	tier: "single-line" | "full" | "progressive";
	counts: SubagentPresentationAsyncCounts;
	multiHeader?: { active: boolean; anyRunning: boolean; glyph?: string; label?: string };
	jobs: SubagentPresentationAsyncJobSection[];
	hidden?: { running: number; finished: number; queued?: number };
	hiddenLine?: string;
}

export type SubagentPresentationFrame = SubagentPresentationFleetFrame | SubagentPresentationAsyncFrame;

export interface SubagentPresentationLayoutRow {
	rowKey: string;
	fromLine: number;
	toLine: number;
	truncated: boolean;
}

export interface SubagentPresentationDrawResult {
	lines: string[];
	layout: SubagentPresentationLayoutRow[];
}

export type SubagentPresentationFleetDraw = (frame: SubagentPresentationFleetFrame) => SubagentPresentationDrawResult;
export type SubagentPresentationAsyncDraw = (frame: SubagentPresentationAsyncFrame) => SubagentPresentationDrawResult;
/** Per-surface draw signatures, keyed by surface. */
export type SubagentPresentationSurfaces = Partial<{
	fleet: SubagentPresentationFleetDraw;
	async: SubagentPresentationAsyncDraw;
}>;

export interface SubagentPresentationRegistrationHandle {
	token: string;
	identity: string;
	generation: number;
	surfaces: SubagentPresentationSurface[];
	dispose(): void;
}

export type SubagentPresentationRegistrationStatus =
	| { status: "activated"; handle: SubagentPresentationRegistrationHandle; surfaces: SubagentPresentationSurface[] }
	| { status: "replaced"; handle: SubagentPresentationRegistrationHandle; surfaces: SubagentPresentationSurface[] }
	| { status: "not-ready"; reason: string }
	| { status: "incompatible"; reason: string }
	| { status: "conflict"; reason: string };

export interface SubagentPresentationReadyPayload {
	protocol: number;
	surfaces: SubagentPresentationSurface[];
	session: string | null;
	runtimeGeneration: number;
	events: {
		ready: typeof SUBAGENT_PRESENTATION_READY_EVENT;
		register: typeof SUBAGENT_PRESENTATION_REGISTER_EVENT;
		withdraw: typeof SUBAGENT_PRESENTATION_WITHDRAW_EVENT;
		diagnostic: typeof SUBAGENT_PRESENTATION_DIAGNOSTIC_EVENT;
	};
}

export interface SubagentPresentationDiagnosticPayload {
	protocol: number;
	identity: string;
	surface: SubagentPresentationSurface;
	reason: string;
	occurrence: number;
}

const REPLY_CHANNEL_PREFIX = "pi-subagents:presentation:v1:reply:";

/**
 * Register drawing adapters with the pi-subagents presentation host. The
 * handshake is bounded (no permanent retry timers); a miss resolves
 * "not-ready" so the caller can fall back to native and stay diagnostic.
 */
export async function registerSubagentPresentation(options: {
	events: SubagentPresentationEventBus;
	identity: string;
	surfaces: SubagentPresentationSurfaces;
	session?: string | null;
	runtimeGeneration?: number;
	timeoutMs?: number;
}): Promise<SubagentPresentationRegistrationStatus> {
	const replyChannel = `${REPLY_CHANNEL_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = options.events.on(replyChannel, (payload) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe();
			resolve(payload as SubagentPresentationRegistrationStatus);
		});
		if (options.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsubscribe();
				resolve({ status: "not-ready", reason: "registration handshake timed out" });
			}, options.timeoutMs);
			timer.unref?.();
		}
		options.events.emit(SUBAGENT_PRESENTATION_REGISTER_EVENT, {
			protocol: SUBAGENT_PRESENTATION_PROTOCOL_VERSION,
			replyChannel,
			request: {
				identity: options.identity,
				session: options.session,
				runtimeGeneration: options.runtimeGeneration,
				surfaces: options.surfaces,
			},
		});
	});
}

/** Probe for a live presentation host; null when nobody answers in time. */
export async function probeSubagentPresentation(options: {
	events: SubagentPresentationEventBus;
	timeoutMs?: number;
}): Promise<SubagentPresentationReadyPayload | null> {
	return new Promise((resolve) => {
		let settled = false;
		const unsubscribe = options.events.on(SUBAGENT_PRESENTATION_READY_EVENT, (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			const ready = payload as SubagentPresentationReadyPayload;
			resolve(ready?.protocol === SUBAGENT_PRESENTATION_PROTOCOL_VERSION ? ready : null);
		});
		const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(null);
		}, options.timeoutMs ?? 1_000);
		timer.unref?.();
		options.events.emit(SUBAGENT_PRESENTATION_PROBE_EVENT, { protocol: SUBAGENT_PRESENTATION_PROTOCOL_VERSION });
	});
}

// ---- Bridge (P3): registration lifecycle for the CC adapters ----

export type SubagentPresentationBridgeStatus =
	| "off"
	| "registering"
	| "active"
	| "unsupported"
	| "no-host";

export interface SubagentPresentationBridgeOptions {
	events: SubagentPresentationEventBus;
	/** Drawing per surface this bridge registers. */
	surfaces: SubagentPresentationSurfaces;
	identity?: string;
	/** Diagnostics surfacing (upstream already dedupes per session+reason). */
	onDiagnostic?: (payload: SubagentPresentationDiagnosticPayload) => void;
	onStatusChange?: (status: SubagentPresentationBridgeStatus) => void;
	/** Bounded handshake waits only — never a permanent retry timer. */
	handshakeTimeoutMs?: number;
}

/**
 * Owns the CC side of the presentation seam: probe at session start,
 * register once a host answers, re-register when a host becomes ready later
 * (load order independence), and withdraw cleanly on stop. Withdraw and
 * re-registration are idempotent; stale handles from an older runtime are
 * generation-guarded upstream and never withdrawn twice here.
 *
 * The bridge holds no theme, no ctx, and no timers beyond the bounded
 * handshake — frames carry the current theme per draw, so nothing captured
 * here can go stale.
 */
export class SubagentPresentationBridge {
	private readonly options: SubagentPresentationBridgeOptions;
	private handle: SubagentPresentationRegistrationHandle | undefined;
	private session: string | null = null;
	private state: SubagentPresentationBridgeStatus = "off";
	private readonly unsubscribers: Array<() => void> = [];

	constructor(options: SubagentPresentationBridgeOptions) {
		this.options = options;
		this.unsubscribers.push(options.events.on(SUBAGENT_PRESENTATION_READY_EVENT, (payload) => {
			const ready = payload as SubagentPresentationReadyPayload;
			if (ready?.protocol !== SUBAGENT_PRESENTATION_PROTOCOL_VERSION) {
				this.setStatus("unsupported");
				return;
			}
			// A host became (or re-became) ready: (re)register whenever the
			// bridge is not explicitly stopped — including after a probe miss
			// (host loaded later than the probe window).
			if (this.state !== "off") void this.register(ready);
		}));
		this.unsubscribers.push(options.events.on(SUBAGENT_PRESENTATION_DIAGNOSTIC_EVENT, (payload) => {
			const diagnostic = payload as SubagentPresentationDiagnosticPayload;
			if (diagnostic?.protocol === SUBAGENT_PRESENTATION_PROTOCOL_VERSION) this.options.onDiagnostic?.(diagnostic);
		}));
	}

	/** Session activation point (enable / session_start). */
	start(session: string | null): void {
		this.session = session;
		this.setStatus("registering");
		void this.probeAndRegister();
	}

	/** Withdraw point (disable / session_shutdown). Idempotent. */
	stop(): void {
		this.withdraw();
		this.session = null;
		this.setStatus("off");
	}

	dispose(): void {
		this.stop();
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.unsubscribers.length = 0;
	}

	status(): SubagentPresentationBridgeStatus {
		return this.state;
	}

	currentSession(): string | null {
		return this.session;
	}

	private async probeAndRegister(): Promise<void> {
		const ready = await probeSubagentPresentation({ events: this.options.events, timeoutMs: this.options.handshakeTimeoutMs ?? 250 });
		if (this.state !== "registering") return;
		if (!ready) {
			this.setStatus("no-host");
			return;
		}
		await this.register(ready);
	}

	private async register(ready: SubagentPresentationReadyPayload): Promise<void> {
		// Only register surfaces the host actually offers; the full bottom-bar
		// capability needs both, partial availability still displays.
		const surfaces = Object.fromEntries(Object.entries(this.options.surfaces).filter(([surface]) => ready.surfaces.includes(surface as SubagentPresentationSurface)));
		if (!Object.keys(surfaces).length) {
			this.setStatus("unsupported");
			return;
		}
		const result = await registerSubagentPresentation({
			events: this.options.events,
			identity: this.options.identity ?? "cc-tui",
			surfaces: surfaces as SubagentPresentationSurfaces,
			session: ready.session ?? this.session,
			runtimeGeneration: ready.runtimeGeneration,
			timeoutMs: this.options.handshakeTimeoutMs ?? 250,
		});
		// Ignore responses that arrive after an explicit stop(); any other
		// late arrival (probe + ready overlap, no-host recovery) is valid.
		if (this.state === "off") return;
		if (result.status === "activated" || result.status === "replaced") {
			this.withdraw();
			this.handle = result.handle;
			this.setStatus("active");
		} else if (result.status === "not-ready") {
			// Session/generation raced (host restarted between probe and
			// register). The next ready broadcast re-registers.
			this.withdraw();
			this.setStatus("registering");
		} else {
			this.setStatus("unsupported");
		}
	}

	private withdraw(): void {
		try {
			this.handle?.dispose();
		} catch {
			// A stale handle from a replaced runtime: nothing to restore.
		}
		this.handle = undefined;
	}

	private setStatus(status: SubagentPresentationBridgeStatus): void {
		if (this.state === status) return;
		this.state = status;
		this.options.onStatusChange?.(status);
	}
}
