/**
 * Run/compaction state machine for the cc-status spinner line
 * (extracted 2026-10-03 from the entry factory).
 *
 * Seven mutable variables (verb / runStart / tickTimer / running /
 * compacting / spinnerIdx / lastWorkedLine) and four closure functions used
 * to hold an implicit state machine whose transition rules lived only in
 * comments — the tick timer had two owners (run tick and compaction tick
 * share one handle), and any unusual event sequence (agent_start mid-
 * compaction, disable mid-run) had to be hand-traced.
 *
 * All transitions are now explicit and table-tested with an injected
 * clock/timer. Invariants owned here:
 * - tickTimer has ONE owner (this module); compaction reuses the run tick.
 * - startRun clears any prior tick (including a compaction's) and rebuilds.
 * - stopCompaction stops the tick only when no run is active.
 * - endRun always stops the tick and clears `running`; the completion line
 *   is emitted only when the host is still enabled AND the run lasted ≥1s.
 * - The verb is sampled ONCE per run (CC Spinner.tsx parity) and never
 *   rotates; liveliness is the shimmer band riding the same tick.
 * - A throwing onTick (stale ctx) stops the tick quietly — never throws
 *   through render stacks (AGENTS.md trap 1).
 */

export interface TimerLike {
	// opaque handle — the entry injects setInterval/clearInterval
}

export interface RunStateDeps {
	/** Injected clock (Date.now in production). */
	now(): number;
	setTick(fn: () => void, ms: number): TimerLike;
	clearTick(handle: TimerLike): void;
	/** Spinner cadence (SPINNER_TICK_MS — 200ms, the settled CC cadence). */
	tickMs: number;
	/** Non-forced render request (keeps pi's line-diff cache intact, A8). */
	requestRender(): void;
	/** Master switch (entry's `enabled`) — gates the completion line. */
	isEnabled(): boolean;
	/** Weighted sample once per run (spinner-verbs). */
	pickRunVerb(): string;
	/** Past-tense verb for the completion line (TURN_COMPLETION_VERBS). */
	pickCompletionVerb(): string;
	/** `✻ Verb for Xs · HH:MM` (format.buildCompletionLine). */
	completionLine(verb: string, elapsedMs: number, endTs: number): string;
}

export interface RunView {
	running: boolean;
	compacting: boolean;
	spinnerIdx: number;
	runStart: number;
	verb: string;
	lastWorkedLine: string;
}

export class RunStateMachine {
	private readonly d: RunStateDeps;
	private tickTimer: TimerLike | null = null;
	private running_ = false;
	private compacting_ = false;
	private spinnerIdx_ = 0;
	private runStart_ = 0;
	private verb_: string;
	private lastWorkedLine_ = "";

	constructor(deps: RunStateDeps) {
		this.d = deps;
		this.verb_ = deps.pickRunVerb();
	}

	view(): RunView {
		return {
			running: this.running_,
			compacting: this.compacting_,
			spinnerIdx: this.spinnerIdx_,
			runStart: this.runStart_,
			verb: this.verb_,
			lastWorkedLine: this.lastWorkedLine_,
		};
	}

	/** agent_start: fresh run — clear the completion line, resample the
	 * verb once, take over the tick (a compaction's tick included). */
	startRun(): void {
		this.lastWorkedLine_ = "";
		this.running_ = true;
		this.runStart_ = this.d.now();
		this.verb_ = this.d.pickRunVerb();
		this.stopTick();
		this.startTick();
	}

	/** agent_settled: stop the tick and clear `running` unconditionally;
	 * log the turn-completion line only when enabled and the run ≥1s. */
	endRun(): void {
		this.stopTick();
		this.running_ = false;
		if (!this.d.isEnabled() || this.runStart_ === 0) return;
		const endTs = this.d.now();
		const elapsed = endTs - this.runStart_;
		this.runStart_ = 0;
		if (elapsed >= 1000) {
			this.lastWorkedLine_ = this.d.completionLine(this.d.pickCompletionVerb(), elapsed, endTs);
			this.d.requestRender();
		}
	}

	/** session_before_compact: mirror compaction on the spinner line; idle
	 * compaction owns the tick for its duration. */
	startCompaction(): void {
		this.compacting_ = true;
		if (!this.tickTimer) this.startTick();
	}

	/** session_compact / session_compact_failed: keep the tick alive while
	 * a run is still in flight (the run owns it again). */
	stopCompaction(): void {
		this.compacting_ = false;
		if (!this.running_) this.stopTick();
		this.d.requestRender();
	}

	/** session_shutdown / disable: stop ticking, keep the last view. */
	halt(): void {
		this.stopTick();
		this.running_ = false;
	}

	/** /claude-verb: manual reroll — the user's explicit choice overrides
	 * the sample-once-per-run rule for the current run. */
	rerollVerb(): string {
		this.verb_ = this.d.pickRunVerb();
		return this.verb_;
	}

	private startTick(): void {
		this.tickTimer = this.d.setTick(() => {
			try {
				this.spinnerIdx_++;
				this.d.requestRender();
			} catch {
				// Stale ctx (session replaced/reloaded mid-run): stop ticking
				// quietly instead of throwing uncaught (kills pi).
				this.stopTick();
			}
		}, this.d.tickMs);
	}

	private stopTick(): void {
		if (this.tickTimer) {
			this.d.clearTick(this.tickTimer);
			this.tickTimer = null;
		}
	}
}
