/**
 * bg-tasks-capability oracle tests: the footer's bg-shell pill reads core's
 * task registry off the well-known `Symbol.for` global. That probe is a
 * host-identification oracle (CC footer pill parity): registry absent or
 * misshapen must fail open to 0 — a missing core must never break the
 * footer — while a live registry must count exactly the running tasks.
 * The row rendering itself is bg-task-row.test.ts; this file pins the
 * identification (registry probe hit/miss) and the CC pill-label format.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { bgShellPillText, runningBgShells } from "../extensions/lib/bg-tasks-capability.ts";

// Same well-known key the capability reads; owned by core's bg-shell
// module — we only plant/remove it for the probe window.
const REGISTRY_KEY = Symbol.for("cc-core.bg-shell.registry");
const globals = globalThis as unknown as Record<symbol, unknown>;

const withRegistry = (holder: unknown, run: () => void): void => {
	const saved = globals[REGISTRY_KEY];
	globals[REGISTRY_KEY] = holder;
	try {
		run();
	} finally {
		if (saved === undefined) delete globals[REGISTRY_KEY];
		else globals[REGISTRY_KEY] = saved;
	}
};

test("runningBgShells hit: counts only running tasks in a live registry", () => {
	withRegistry(
		{
			tasks: new Map([
				["bg-1", { state: "running" }],
				["bg-2", { state: "running" }],
				["bg-3", { state: "exited" }],
				["bg-4", { state: "killed" }],
				["bg-5", {}], // task never set a state — not running
				["bg-6", null], // defensive: skip non-objects entirely
			]),
		},
		() => {
			assert.equal(runningBgShells(), 2);
		},
	);
});

test("runningBgShells miss: absent registry, non-object holder, non-Map tasks → 0", () => {
	assert.equal(runningBgShells(), 0, "no core loaded — the common case");
	withRegistry(undefined, () => assert.equal(runningBgShells(), 0));
	withRegistry("not-a-registry", () => assert.equal(runningBgShells(), 0, "holder must be an object"));
	withRegistry(42, () => assert.equal(runningBgShells(), 0));
	// A plain object / array is NOT the registry contract (Map identity).
	withRegistry({ tasks: { "bg-1": { state: "running" } } }, () => assert.equal(runningBgShells(), 0));
	withRegistry({ tasks: [{ state: "running" }] }, () => assert.equal(runningBgShells(), 0));
	withRegistry({}, () => assert.equal(runningBgShells(), 0, "tasks channel absent"));
});

test("bgShellPillText: CC pillLabel parity — '' at 0, singular at 1, plural above", () => {
	assert.equal(bgShellPillText(0), "", "CC renders no pill at 0");
	assert.equal(bgShellPillText(1), "1 shell");
	assert.equal(bgShellPillText(3), "3 shells");
	assert.equal(bgShellPillText(-1), "", "never a negative pill");
});
