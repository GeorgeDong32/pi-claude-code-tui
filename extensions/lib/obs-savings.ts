/*
 * Observation-pack per-site savings adapter (OBS-09-SITES; spec
 * 2026-10-07 P0-2/B5).
 *
 * The core's observation pack publishes, on its capability bus
 * (globalThis.__piClaudeCodeCore), one `observation.sites` array per
 * request in which results were FIRST replaced by placeholders — each
 * entry { tool, id, avoidedTokens, toolCallId? } is that observation's
 * removed tokens (upstream SoL-Pi showSolPiSavings single-site semantics).
 *
 * Subscription lifecycle lives in lib/core-bus.ts; this module contributes
 * the sites adapter:
 *   - dedupe by the FULL site tuple (tool/id/toolCallId/avoidedTokens —
 *     B5: the old id:tokens key ignored toolCallId, so a stop→start cycle
 *     re-delivered the persisted array as a duplicate row). The baseline is
 *     captured at PRESENCE DECLARATION (activate) — a late attach never
 *     re-truncates it.
 *   - the channel PERSISTS the latest batch in the snapshot between
 *     publishes; unrelated publishes re-deliver the same array — only
 *     genuinely unseen sites reach the callback.
 *   - dedupe domain is the CURRENT session/branch: onDetach clears it (/new),
 *     and a reload/resume rebuilds it from the branch's persisted
 *     cc-tui/observation-packed entries (resetSeenFromBranch — event path
 *     only, never inside render). Sites from before the takeover are NOT
 *     back-filled; the channel keeps only the last batch, so earlier
 *     overwritten batches cannot be recovered (no fake event log).
 *   - callback failures are swallowed and the batch is marked attempted —
 *     display must never break the subscription.
 *   - absent channel (old core) → nothing delivered, silently.
 */

import { obsSiteKey, obsSitesOf, type CoreBusAdapter, type CoreBusHandoff, type CoreSnapshotLike } from "./core-bus.ts";

export interface ObsSavingsSite {
	readonly tool: string;
	readonly id: string;
	readonly avoidedTokens: number;
	/** The transcript toolResult this site packed (OBS-09-SITES v2; absent on old cores). */
	readonly toolCallId?: string;
}

const SNAPSHOT_KEY = "__piClaudeCodeCore";
const PACKED_ENTRY_TYPE = "cc-tui/observation-packed";

export function readObsSites(globalStore: Record<string, unknown> = globalThis as never): ObsSavingsSite[] {
	return obsSitesOf(globalStore[SNAPSHOT_KEY] as CoreSnapshotLike | undefined);
}

export interface ObsAdapter {
	adapter: CoreBusAdapter;
	/**
	 * Rebuild the seen-key set from a session branch's persisted packed
	 * entries (reload/resume) so already-shown sites are not re-delivered.
	 * Event-path only — never called from render.
	 */
	resetSeenFromBranch(branch: readonly unknown[]): void;
}

export function createObsAdapter(onSites: (sites: ObsSavingsSite[]) => void): ObsAdapter {
	// Session-scoped: which sites already have a display entry THIS session.
	let seen = new Set<string>();

	const deliverNew = (sites: readonly ObsSavingsSite[]): void => {
		if (sites.length === 0) return;
		const fresh = sites.filter((site) => !seen.has(obsSiteKey(site)));
		if (fresh.length === 0) return;
		// Mark attempted BEFORE the callback: a throwing display drops this
		// batch for good instead of replaying it on every publish.
		for (const site of fresh) seen.add(obsSiteKey(site));
		try {
			onSites(fresh);
		} catch {
			// drop this batch — display must never break the subscription
		}
	};

	return {
		adapter: {
			onAttach(snapshot: CoreSnapshotLike, handoff: CoreBusHandoff) {
				// History baseline from the declaration moment, UNIONED with
				// keys already known this session (resetSeenFromBranch ran
				// before activate on reload/resume — those entries exist in
				// the transcript and must stay suppressed). The current
				// snapshot is then diffed, so only the handoff window's
				// newest batch is delivered.
				seen = new Set([...seen, ...handoff.obsBaselineKeys]);
				deliverNew(obsSitesOf(snapshot));
			},
			onSnapshot(snapshot) {
				deliverNew(obsSitesOf(snapshot));
			},
			onDetach() {
				seen = new Set();
			},
		},
		resetSeenFromBranch(branch: readonly unknown[]): void {
			try {
				for (const entry of branch) {
					if (entry == null || typeof entry !== "object") continue;
					const typed = entry as { customType?: unknown; data?: unknown };
					if (typed.customType !== PACKED_ENTRY_TYPE) continue;
					const sites = (typed.data as { sites?: unknown } | null | undefined)?.sites;
					if (!Array.isArray(sites)) continue;
					for (const site of obsSitesOf({ observation: { sites } })) seen.add(obsSiteKey(site));
				}
			} catch {
				// branch scan is best-effort resume hygiene
			}
		},
	};
}
