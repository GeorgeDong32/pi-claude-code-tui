/**
 * Usage snapshot for the cc-status row (plan A7).
 *
 * pi appends branch entries at message boundaries, so scanning the whole
 * branch on every render frame was pure waste — the widget re-summed the
 * session per keystroke and per spinner tick. The tracker recomputes once
 * per observed change and serves the cached numbers to every frame.
 * Semantics preserved exactly: `used` = the LAST assistant message's
 * cumulative usage; `cost` = the sum across assistant messages.
 *
 * Plan SL3 extends the same single scan with the splits the statusline JSON
 * needs: last/total input+output per the CC current_usage/total_* contract.
 */

export interface UsageSnapshot {
	used: number;
	cost: number;
	/** Last assistant message's raw input/output (statusline current_usage). */
	lastInput: number;
	lastOutput: number;
	/** Session-cumulative input/output across assistant messages (pi footer mouth). */
	totalInput: number;
	totalOutput: number;
}

export interface BranchEntryLike {
	type?: string;
	customType?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			cost?: { total?: number };
		};
	};
}

export class UsageTracker {
	private snapshot: UsageSnapshot = { used: 0, cost: 0, lastInput: 0, lastOutput: 0, totalInput: 0, totalOutput: 0 };

	/** Recompute from a branch (call at message_end / session_start). */
	observe(branch: BranchEntryLike[]): UsageSnapshot {
		let used = 0;
		let cost = 0;
		let lastInput = 0;
		let lastOutput = 0;
		let totalInput = 0;
		let totalOutput = 0;
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const usage = entry.message.usage;
			if (!usage) continue;
			used = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			lastInput = usage.input || 0;
			lastOutput = usage.output || 0;
			totalInput += usage.input || 0;
			totalOutput += usage.output || 0;
			cost += usage.cost?.total || 0;
		}
		this.snapshot = { used, cost, lastInput, lastOutput, totalInput, totalOutput };
		return this.snapshot;
	}

	get(): UsageSnapshot {
		return this.snapshot;
	}
}

/**
 * Host event-ordering knowledge for usage sampling (spec 8.2), verified
 * against pi 1.0.2's agent-session.js:
 *
 * - `message_end` reaches extensions BEFORE `sessionManager.appendMessage`
 *   persists the just-finished message. A branch scan there lags by exactly
 *   one assistant message — still correct for every earlier turn.
 * - `agent_settled` fires after the run loop finishes, i.e. after the final
 *   append. Observing there guarantees the final value even when no user
 *   message follows (the exact miss this fixes).
 * - `session_tree` (branch switch/resume) and `session_compact` (branch
 *   rewrite) invalidate the snapshot: the next observation must recompute
 *   from the new branch, never carry stale numbers over.
 *
 * The event message's own usage is deliberately NOT merged into a branch
 * scan — appending it double-counts once the message persists.
 */
export const USAGE_OBSERVATION_POINTS = [
	"message_end", // tool-turn timeliness (lags one message by design)
	"agent_settled", // post-append: guarantees the final value
	"session_start", // branch (re)load
	"session_tree", // branch switch / resume
	"session_compact", // compaction rewrote the branch
] as const;

export type UsageObservationPoint = (typeof USAGE_OBSERVATION_POINTS)[number];

// ── P1-2 step 2 (spec U2): the ONE display-usage selection ─────────────────
//
// core's structured channel (modes.usage) wins per-field; the tracker fills
// every field core does not provide. A TRUE ZERO in a core field is valid
// data (never treated as missing); a missing/invalid CHANNEL falls back to
// the tracker wholesale. Both percentage fields of the statusline JSON and
// the right group derive from the SAME clamped, once-rounded value.

import type { CoreUsageLike } from "./core-bus.ts";

export interface DisplayUsage {
	/** Selected cost (core-preferred; true 0 kept). */
	cost: number;
	/** Clamped [0,100] used percentage, rounded ONCE — the only pct source. null = no basis. */
	usedPercent: number | null;
	/** Context tokens for the (used/win) label; null when the source lacks them. */
	usedTokens: number | null;
	/** Effective context window for display. */
	contextWindow: number;
	/** Cumulative totals from the selected source (statusline total_*). */
	totalInput: number;
	totalOutput: number;
	/**
	 * Structured left-segment numbers (core channel present). null → the
	 * caller keeps the old-core string path (stripDuplicateStats).
	 */
	structured: { input: number; output: number; cacheRead: number; tps: number } | null;
}

export interface DisplayUsageInput {
	tracker: UsageSnapshot;
	core: CoreUsageLike | null;
	/** Host-provided context window (model_select); the fallback basis. */
	hostContextWindow: number;
}

const clampPercent = (v: number): number => Math.min(100, Math.max(0, Math.round(v)));

export const selectDisplayUsage = (input: DisplayUsageInput): DisplayUsage => {
	const { tracker, core, hostContextWindow } = input;
	if (core === null) {
		// No structured channel (old core / cleared / invalid): tracker only.
		const basis = hostContextWindow > 0 && tracker.used > 0 ? tracker.used / hostContextWindow * 100 : null;
		return {
			cost: tracker.cost,
			usedPercent: basis !== null ? clampPercent(basis) : null,
			usedTokens: tracker.used > 0 ? tracker.used : null,
			contextWindow: hostContextWindow,
			totalInput: tracker.totalInput,
			totalOutput: tracker.totalOutput,
			structured: null,
		};
	}
	// Structured channel present. Cost is an independent unit (core-preferred
	// per field). The ctx DISPLAY picks ONE basis so pct and tokens never mix
	// sources: core percent → core tokens (window = channel window, else
	// host) → tracker (both fields, consistent). A channel that omits BOTH
	// ctx fields therefore reads the tracker's percentage — core P2-4 §4.1:
	// absent ctxPercent must NOT become 0%.
	const coreWindow = typeof core.contextWindow === "number" && core.contextWindow > 0 ? core.contextWindow : 0;
	let usedPercent: number | null;
	let usedTokens: number | null;
	if (typeof core.ctxPercent === "number") {
		usedPercent = clampPercent(core.ctxPercent);
		usedTokens = typeof core.ctxTokens === "number" ? core.ctxTokens : null; // pct-only basis: no mixed paren
	} else if (typeof core.ctxTokens === "number") {
		const win = coreWindow > 0 ? coreWindow : hostContextWindow;
		usedPercent = win > 0 ? clampPercent((core.ctxTokens / win) * 100) : null;
		usedTokens = core.ctxTokens;
	} else {
		usedPercent = hostContextWindow > 0 && tracker.used > 0 ? clampPercent((tracker.used / hostContextWindow) * 100) : null;
		usedTokens = tracker.used > 0 ? tracker.used : null;
	}
	return {
		cost: core.cost,
		usedPercent,
		usedTokens,
		contextWindow: coreWindow > 0 ? coreWindow : hostContextWindow,
		totalInput: core.input,
		totalOutput: core.output,
		structured: { input: core.input, output: core.output, cacheRead: core.cacheRead, tps: core.tps ?? 0 },
	};
};
