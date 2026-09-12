/**
 * Usage snapshot for the cc-status row (plan A7).
 *
 * pi appends branch entries at message boundaries, so scanning the whole
 * branch on every render frame was pure waste — the widget re-summed the
 * session per keystroke and per spinner tick. The tracker recomputes once
 * per observed change and serves the cached numbers to every frame.
 * Semantics preserved exactly: `used` = the LAST assistant message's
 * cumulative usage; `cost` = the sum across assistant messages.
 */

export interface UsageSnapshot {
	used: number;
	cost: number;
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
	private snapshot: UsageSnapshot = { used: 0, cost: 0 };

	/** Recompute from a branch (call at message_end / session_start). */
	observe(branch: BranchEntryLike[]): UsageSnapshot {
		let used = 0;
		let cost = 0;
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
			const usage = entry.message.usage;
			if (!usage) continue;
			used = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			cost += usage.cost?.total || 0;
		}
		this.snapshot = { used, cost };
		return this.snapshot;
	}

	get(): UsageSnapshot {
		return this.snapshot;
	}
}
