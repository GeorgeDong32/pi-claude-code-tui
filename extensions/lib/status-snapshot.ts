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
