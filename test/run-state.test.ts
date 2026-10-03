/**
 * Run-state transition tests: every event sequence the old closure state
 * machine could only be hand-traced through, driven on an injected
 * clock/timer. The completion-line verb is injected deterministically.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { RunStateMachine, type RunStateDeps, type TimerLike } from "../extensions/lib/run-state.ts";

interface Harness {
	machine: RunStateMachine;
	tickFns: Array<() => void>;
	now: number;
	enabled: boolean;
	renders: number;
	advance(ms: number, stepMs?: number): void;
	fireErrorTick(): void;
	liveTimers(): number;
}

const makeHarness = (opts: { enabled?: boolean } = {}): Harness => {
	const tickFns: Array<() => void> = [];
	let live = 0;
	let now = 1_000_000;
	let enabled = opts.enabled ?? true;
	let renders = 0;
	let runVerbSeq = 0;
	const deps: RunStateDeps = {
		now: () => now,
		setTick(fn) {
			tickFns.push(fn);
			live++;
			return {} as TimerLike;
		},
		clearTick() {
			live--;
			// the fn stays in tickFns; firing it after clear must be a no-op
			// only via live count — the machine never fires cleared fns itself
		},
		tickMs: 200,
		requestRender() {
			renders++;
		},
		isEnabled: () => enabled,
		pickRunVerb: () => `verb-${++runVerbSeq}`,
		pickCompletionVerb: () => "Baked",
		completionLine: (verb, elapsed, endTs) => `✻ ${verb} for ${Math.round(elapsed / 1000)}s · ${endTs}`,
	};
	const machine = new RunStateMachine(deps);
	return {
		machine,
		tickFns,
		get now() {
			return now;
		},
		set now(v: number) {
			now = v;
		},
		get enabled() {
			return enabled;
		},
		set enabled(v: boolean) {
			enabled = v;
		},
		get renders() {
			return renders;
		},
		advance(ms: number, stepMs = 200) {
			for (let t = 0; t < ms; t += stepMs) {
				const fns = [...tickFns];
				for (const fn of fns) fn();
			}
			now += ms;
		},
		fireErrorTick() {
			const savedRender = deps.requestRender;
			// force a throw inside the tick body
			Object.defineProperty(deps, "requestRender", {
				configurable: true,
				get() {
					throw new Error("stale ctx");
				},
			});
			try {
				for (const fn of [...tickFns]) fn();
			} finally {
				Object.defineProperty(deps, "requestRender", {
					configurable: true,
					value: savedRender,
					writable: true,
				});
			}
		},
		liveTimers: () => live,
	};
};

test("startRun: fresh verb sampled once, completion cleared, tick advances the spinner", () => {
	const h = makeHarness();
	h.machine.startRun();
	let v = h.machine.view();
	assert.ok(v.running && v.runStart > 0 && v.lastWorkedLine === "");
	const verb0 = v.verb;
	h.advance(600);
	v = h.machine.view();
	assert.equal(v.verb, verb0, "verb never rotates mid-run");
	assert.ok(v.spinnerIdx >= 3, "tick advances the spinner");
	assert.ok(h.liveTimers() >= 1);
});

test("endRun: ≥1s emits the completion line; <1s stays silent", () => {
	const h = makeHarness();
	h.machine.startRun();
	h.advance(1500);
	h.machine.endRun();
	const v = h.machine.view();
	assert.ok(!v.running);
	assert.match(v.lastWorkedLine, /✻ Baked for \ds/);
	assert.equal(h.liveTimers(), 0, "tick stopped at end");

	const h2 = makeHarness();
	h2.machine.startRun();
	h2.advance(400);
	h2.machine.endRun();
	assert.equal(h2.machine.view().lastWorkedLine, "", "sub-second runs leave no completion line");
});

test("idle compaction owns the tick and hands it back on stop", () => {
	const h = makeHarness();
	h.machine.startCompaction();
	assert.ok(h.machine.view().compacting);
	assert.ok(h.liveTimers() >= 1, "idle compaction starts the tick");
	h.machine.stopCompaction();
	assert.ok(!h.machine.view().compacting);
	assert.equal(h.liveTimers(), 0, "no run active → tick stops with compaction");
});

test("compaction mid-run keeps the tick; endRun reclaims and stops it", () => {
	const h = makeHarness();
	h.machine.startRun();
	h.machine.startCompaction();
	assert.equal(h.liveTimers(), 1, "compaction reuses the run tick");
	h.machine.stopCompaction();
	assert.ok(h.machine.view().running, "run still in flight");
	assert.equal(h.liveTimers(), 1, "tick stays while a run owns it");
	h.machine.endRun();
	assert.equal(h.liveTimers(), 0);
});

test("startRun mid-compaction rebuilds the tick (old handle cleared)", () => {
	const h = makeHarness();
	h.machine.startCompaction();
	h.machine.startRun();
	const v = h.machine.view();
	assert.ok(v.running && v.compacting, "compaction flag survives; the run takes the line");
	assert.equal(h.liveTimers(), 1, "exactly one live tick after rebuild");
});

test("a throwing tick stops quietly — nothing escapes the render stack", () => {
	const h = makeHarness();
	h.machine.startRun();
	assert.doesNotThrow(() => h.fireErrorTick());
	assert.equal(h.liveTimers(), 0, "tick halted after the throw");
	assert.ok(h.machine.view().running, "bookkeeping unchanged — only the tick stopped");
});

test("endRun with the host disabled still stops the tick but skips the completion line", () => {
	const h = makeHarness();
	h.machine.startRun();
	h.advance(2000);
	h.enabled = false;
	h.machine.endRun();
	const v = h.machine.view();
	assert.ok(!v.running);
	assert.equal(h.liveTimers(), 0);
	assert.equal(v.lastWorkedLine, "", "disabled host logs no completion");
});

test("halt (shutdown/disable) stops the tick and the running flag", () => {
	const h = makeHarness();
	h.machine.startRun();
	h.machine.halt();
	assert.equal(h.liveTimers(), 0);
	assert.ok(!h.machine.view().running);
});
