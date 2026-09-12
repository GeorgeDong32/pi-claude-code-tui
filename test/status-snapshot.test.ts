/** UsageTracker semantics pin (plan A7): used = last assistant cumulative,
 *  cost = sum — the exact behavior of the per-frame branch scan it replaces. */
import test from "node:test";
import assert from "node:assert/strict";

import { UsageTracker } from "../extensions/lib/status-snapshot.ts";

const assistant = (usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: number }) => ({
	type: "message",
	message: { role: "assistant", usage: { cacheRead: 0, cacheWrite: 0, ...usage, cost: { total: usage.cost } } },
});

test("used takes the LAST assistant cumulative; cost sums across messages", () => {
	const tracker = new UsageTracker();
	const snapshot = tracker.observe([
		{ type: "message", message: { role: "user", content: "hi" } },
		assistant({ input: 10, output: 5, cost: 0.01 }),
		{ type: "message", message: { role: "toolResult", content: [] } },
		assistant({ input: 40, output: 8, cacheRead: 2, cost: 0.02 }),
	]);
	assert.equal(snapshot.used, 40 + 8 + 2 + 0);
	assert.ok(Math.abs(snapshot.cost - 0.03) < 1e-12);
});

test("non-assistant entries and missing usage are ignored", () => {
	const tracker = new UsageTracker();
	const snapshot = tracker.observe([
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: [] } },
		{ type: "custom", customType: "modes" },
	]);
	assert.deepEqual(snapshot, { used: 0, cost: 0 });
});

test("get() serves the cached snapshot between observations", () => {
	const tracker = new UsageTracker();
	const branch = [assistant({ input: 1, output: 1, cost: 0 })];
	const observed = tracker.observe(branch);
	assert.equal(tracker.get(), observed, "same object identity while unchanged");
});
