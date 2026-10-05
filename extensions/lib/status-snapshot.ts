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
