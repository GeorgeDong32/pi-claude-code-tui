/*
 * Observation-pack per-site savings flash (OBS-09 consumer).
 *
 * The core's observation pack publishes, on its capability bus
 * (globalThis.__piClaudeCodeCore), one `observation.sites` array per request
 * in which results were FIRST replaced by placeholders — each entry
 * { tool, id, avoidedTokens } is that observation's removed tokens. That is
 * the upstream SoL-Pi showSolPiSavings moment (single-site semantics, not
 * session-cumulative): flash a host status line for 4s, then clear.
 *
 * Consumer contract (this module):
 *   - subscribe via the snapshot's data-carried onChange (same pattern as
 *     pm-capability); load order puts cctui before core, so attach is
 *     idempotent and the ENTRY retries at enable / session_start / status
 *     render — the first retry after core's first publish attaches it.
 *   - fast-forward past the snapshot's history at attach time (a pack that
 *     happened before we attached is stale, not a flash).
 *   - dedupe by sites content: the observation channel PERSISTS in the
 *     snapshot between publishes, so unrelated publishes re-deliver the old
 *     array — only a genuinely new array flashes.
 *   - never throw (render-lifecycle red line): a failing setStatus drops
 *     that flash, not the subscription.
 *   - absent channel (old core) → silent no-op.
 */

export interface ObsSavingsSite {
	readonly tool: string;
	readonly id: string;
	readonly avoidedTokens: number;
	/** The transcript toolResult this site packed (OBS-09-SITES v2; absent on old cores). */
	readonly toolCallId?: string;
}

/** Timer ports injectable for tests; real defaults unref like the original. */
export interface ObsSavingsTimer {
	set(fn: () => void, ms: number): { unref?(): void };
	clear(handle: { unref?(): void }): void;
}

const realTimer: ObsSavingsTimer = {
	set(fn, ms) {
		const t = setTimeout(fn, ms) as unknown as { unref?(): void };
		t.unref?.();
		return t;
	},
	clear(handle) {
		clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0]);
	},
};

const STATUS_KEY = "cc-obs-savings";
const STATUS_DURATION_MS = 4_000;
const SNAPSHOT_KEY = "__piClaudeCodeCore";
const INTEGER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

type SnapshotLike = {
	onChange?: (fn: () => void) => () => void;
	observation?: { sites?: unknown };
};

export function readObsSites(globalStore: Record<string, unknown> = globalThis as never): ObsSavingsSite[] {
	const snap = globalStore[SNAPSHOT_KEY] as SnapshotLike | undefined;
	const sites = snap?.observation?.sites;
	if (!Array.isArray(sites)) return [];
	const parsed: ObsSavingsSite[] = [];
	for (const site of sites) {
		if (typeof site !== "object" || site === null) continue;
		const { tool, id, avoidedTokens, toolCallId } = site as Record<string, unknown>;
		if (typeof tool !== "string" || typeof id !== "string" || typeof avoidedTokens !== "number") continue;
		parsed.push(typeof toolCallId === "string" ? { tool, id, avoidedTokens, toolCallId } : { tool, id, avoidedTokens });
	}
	return parsed;
}

/** Upstream formatSavingsCount shape: "12,345 context tokens avoided". */
export function formatObsSavingsStatus(sites: readonly ObsSavingsSite[]): string {
	const tokens = sites.reduce((sum, site) => sum + Math.max(0, Math.round(site.avoidedTokens)), 0);
	const unit = `context tokens avoided`;
	return sites.length > 1
		? `⚡ Observation Pack · ${sites.length} packed results · ${INTEGER_FORMAT.format(tokens)} ${unit}`
		: `⚡ Observation Pack · ${INTEGER_FORMAT.format(tokens)} ${unit}`;
}

let flashSetStatus: ((key: string, text: string | undefined) => void) | null = null;
let flashTimer: ObsSavingsTimer = realTimer;
let unsubscribe: (() => void) | null = null;
let lastKey: string | null = null;
let clearHandle: { unref?(): void } | null = null;

// Per-observation exact savings (OBS-09-SITES): every first-replacement
// publishes its sites once; accumulate id → avoidedTokens so packed tool
// rows (which only see the placeholder text) can join the exact number.
const savingsById = new Map<string, number>();
const packedCallIds = new Map<string, { tokens: number; id: string }>();

/** Exact avoided tokens for a packed observation id, when the bus carried it. */
export function obsAvoidedTokensById(id: string): number | undefined {
	return savingsById.get(id);
}

/**
 * Packed annotation for a transcript toolResult, keyed by toolCallId — the
 * only stable join: pi's context projection rewrites the PROVIDER REQUEST,
 * never the transcript, so the row content stays original forever and the
 * ⚡ annotation must come from the bus, not from content shape.
 */
export function obsPackedAnnotationForCall(toolCallId: string): { tokens: number; id: string } | undefined {
	return packedCallIds.get(toolCallId);
}

function compactTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** The persistent row annotation: "⚡ packed · 12.5k context tokens avoided · obs_xxxx". */
export function formatObsPackedAnnotation(site: { tokens: number; id: string }): string {
	const idTag = site.id.length > 16 ? `${site.id.slice(0, 16)}…` : site.id;
	return `⚡ packed · ${compactTokens(site.tokens)} context tokens avoided · ${idTag}`;
}

// Running flash state, read per frame by the cc-status widget: pi's
// built-in footer renders setStatus texts, but CC footer mode replaces
// that footer — our own widget is the visible surface there. The setStatus
// call still covers native-footer mode; both are driven by the same state.
let runningFlash: { text: string; until: number } | null = null;

/** The active savings flash text, or null once expired/cleared. */
export function currentObsSavingsFlash(now: number = Date.now()): string | null {
	if (!runningFlash) return null;
	return now < runningFlash.until ? runningFlash.text : null;
}

function sitesKey(sites: readonly ObsSavingsSite[]): string {
	return sites.map((site) => `${site.id}:${site.avoidedTokens}`).join("|");
}

function flash(sites: readonly ObsSavingsSite[]): void {
	if (!flashSetStatus) return;
	if (clearHandle) {
		flashTimer.clear(clearHandle);
		clearHandle = null;
	}
	const text = formatObsSavingsStatus(sites);
	runningFlash = { text, until: Date.now() + STATUS_DURATION_MS };
	try {
		flashSetStatus(STATUS_KEY, text);
	} catch {
		// stale ui — the widget segment still shows the flash
	}
	clearHandle = flashTimer.set(() => {
		clearHandle = null;
		runningFlash = null;
		try {
			flashSetStatus?.(STATUS_KEY, undefined);
		} catch {
			// stale ui on clear — nothing to recover
		}
	}, STATUS_DURATION_MS);
}

function trySubscribe(globalStore: Record<string, unknown>): boolean {
	if (unsubscribe || !flashSetStatus) return unsubscribe !== null;
	const snap = globalStore[SNAPSHOT_KEY] as SnapshotLike | undefined;
	const register = snap?.onChange;
	if (!register) return false;
	// Fast-forward: a pack that happened before attach is stale history.
	lastKey = sitesKey(readObsSites(globalStore)) || null;
	unsubscribe = register(() => {
		const sites = readObsSites(globalStore);
		if (sites.length === 0) return;
		const key = sitesKey(sites);
		for (const site of sites) {
			savingsById.set(site.id, site.avoidedTokens);
			if (site.toolCallId) packedCallIds.set(site.toolCallId, { tokens: site.avoidedTokens, id: site.id });
		}
		if (key === lastKey) return; // persisted channel re-delivered
		lastKey = key;
		flash(sites);
	});
	return true;
}

/**
 * Start (or retry) consuming per-site savings — idempotent once attached.
 * Returns false while the core bus is not ready (no onChange yet); the entry
 * re-calls at enable, session_start, and status-widget render frames.
 */
export function startObsSavingsConsumer(
	setStatus: (key: string, text: string | undefined) => void,
	globalStore: Record<string, unknown> = globalThis as never,
	timer: ObsSavingsTimer = realTimer,
): boolean {
	flashSetStatus = setStatus;
	flashTimer = timer;
	return trySubscribe(globalStore);
}

export function stopObsSavingsConsumer(): void {
	unsubscribe?.();
	unsubscribe = null;
	lastKey = null;
	runningFlash = null;
	packedCallIds.clear();
	if (clearHandle) {
		flashTimer.clear(clearHandle);
		clearHandle = null;
	}
	flashSetStatus = null;
	flashTimer = realTimer;
}
