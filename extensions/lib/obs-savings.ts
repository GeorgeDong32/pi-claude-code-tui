/*
 * Observation-pack per-site savings consumer (OBS-09-SITES).
 *
 * The core's observation pack publishes, on its capability bus
 * (globalThis.__piClaudeCodeCore), one `observation.sites` array per
 * request in which results were FIRST replaced by placeholders — each
 * entry { tool, id, avoidedTokens } is that observation's removed tokens
 * (upstream SoL-Pi showSolPiSavings single-site semantics).
 *
 * Consumer contract (this module):
 *   - subscribe via the snapshot's data-carried onChange (same pattern as
 *     pm-capability); load order puts cctui before core, so attach is
 *     idempotent and the ENTRY retries at enable / session_start / status
 *     render — the first retry after core's first publish attaches it.
 *   - dedupe by sites content: the observation channel PERSISTS in the
 *     snapshot between publishes, so unrelated publishes re-deliver the old
 *     array — only a genuinely new array reaches the callback.
 *   - the callback owns presentation (the entry appends a display-only
 *     session entry); callback failures are swallowed, never thrown into
 *     the bus notification path.
 *   - absent channel (old core) → false, silent no-op.
 */

export interface ObsSavingsSite {
	readonly tool: string;
	readonly id: string;
	readonly avoidedTokens: number;
	/** The transcript toolResult this site packed (OBS-09-SITES v2; absent on old cores). */
	readonly toolCallId?: string;
}

const SNAPSHOT_KEY = "__piClaudeCodeCore";

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

let unsubscribe: (() => void) | null = null;
let lastKey: string | null = null;

function sitesKey(sites: readonly ObsSavingsSite[]): string {
	return sites.map((site) => `${site.id}:${site.avoidedTokens}`).join("|");
}

function trySubscribe(globalStore: Record<string, unknown>, onSites: (sites: ObsSavingsSite[]) => void): boolean {
	if (unsubscribe) return true;
	const snap = globalStore[SNAPSHOT_KEY] as SnapshotLike | undefined;
	const register = snap?.onChange;
	if (!register) return false;
	// No fast-forward: every publish carries only that request's own
	// first-replacements; a pre-attach batch already missed its entry, and
	// re-deliveries of the persisted array are deduped by lastKey.
	lastKey = null;
	unsubscribe = register(() => {
		const sites = readObsSites(globalStore);
		if (sites.length === 0) return;
		const key = sitesKey(sites);
		if (key === lastKey) return; // persisted channel re-delivered
		lastKey = key;
		try {
			onSites(sites);
		} catch {
			// drop this batch — display must never break the subscription
		}
	});
	return true;
}

/**
 * Start (or retry) consuming per-site savings — idempotent once attached.
 * Returns false while the core bus is not ready (no onChange yet); the
 * entry re-calls at enable, session_start, and status-widget render frames.
 */
export function startObsSavingsConsumer(
	onSites: (sites: ObsSavingsSite[]) => void,
	globalStore: Record<string, unknown> = globalThis as never,
): boolean {
	return trySubscribe(globalStore, onSites);
}

export function stopObsSavingsConsumer(): void {
	unsubscribe?.();
	unsubscribe = null;
	lastKey = null;
}
