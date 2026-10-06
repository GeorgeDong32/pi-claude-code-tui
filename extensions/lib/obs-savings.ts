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
// Latest packing event, read per frame by the cc-packed widget (the pseudo
// tool row above the editor). Null → widget renders zero rows and collapses.
let latestSites: ObsSavingsSite[] | null = null;

/** The sites of the latest first-replacement publish, or null when none. */
export function packedSitesView(): ObsSavingsSite[] | null {
	return latestSites;
}

/** Clear the packed-event row (the entry calls this on the next user message). */
export function clearPackedSites(): void {
	latestSites = null;
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
	try {
		flashSetStatus(STATUS_KEY, text);
	} catch {
		// stale ui — the persistent row annotation still carries the info
	}
	clearHandle = flashTimer.set(() => {
		clearHandle = null;
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
		if (key === lastKey) return; // persisted channel re-delivered
		lastKey = key;
		latestSites = sites;
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
	latestSites = null;
	if (clearHandle) {
		flashTimer.clear(clearHandle);
		clearHandle = null;
	}
	flashSetStatus = null;
	flashTimer = realTimer;
}
