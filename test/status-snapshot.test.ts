/** UsageTracker semantics pin (plan A7): used = last assistant cumulative,
 *  cost = sum — the exact behavior of the per-frame branch scan it replaces. */
import test from "node:test";
import assert from "node:assert/strict";

import { USAGE_OBSERVATION_POINTS, UsageTracker } from "../extensions/lib/status-snapshot.ts";

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
	assert.deepEqual(snapshot, { used: 0, cost: 0, lastInput: 0, lastOutput: 0, totalInput: 0, totalOutput: 0 });
});

test("SL3 splits: last/total input+output across assistant messages", () => {
	const tracker = new UsageTracker();
	const snapshot = tracker.observe([
		assistant({ input: 10, output: 5, cost: 0.01 }),
		{ type: "message", message: { role: "toolResult", content: [] } },
		assistant({ input: 40, output: 8, cacheRead: 2, cost: 0.02 }),
	]);
	assert.equal(snapshot.lastInput, 40); // LAST assistant, raw input only
	assert.equal(snapshot.lastOutput, 8);
	assert.equal(snapshot.totalInput, 50); // cumulative across both
	assert.equal(snapshot.totalOutput, 13);
	assert.equal(snapshot.used, 40 + 8 + 2 + 0); // legacy mouth unchanged
});

test("get() serves the cached snapshot between observations", () => {
	const tracker = new UsageTracker();
	const branch = [assistant({ input: 1, output: 1, cost: 0 })];
	const observed = tracker.observe(branch);
	assert.equal(tracker.get(), observed, "same object identity while unchanged");
});

// ---- Spec 8.2: host event ordering and branch invalidation ----

test("8.2: message_end lag then agent_settled final — the settled pass shows the true totals", () => {
	const tracker = new UsageTracker();
	// Turn 1 fully persisted; turn 2's message just ended (pi notifies
	// extensions BEFORE appendMessage, so the branch scan misses it).
	const branchAtMessageEnd = [assistant({ input: 100, output: 25, cost: 0.01 })];
	const lagging = tracker.observe(branchAtMessageEnd);
	assert.equal(lagging.used, 125);
	assert.equal(lagging.cost, 0.01);
	// agent_settled fires after the append: the same getBranch() now includes
	// the final message — no follow-up user message required.
	const branchAtSettled = [...branchAtMessageEnd, assistant({ input: 30, output: 5, cost: 0.002 })];
	const settled = tracker.observe(branchAtSettled);
	assert.equal(settled.used, 35);
	assert.equal(settled.cost, 0.012);
	assert.equal(settled.totalInput, 130);
	assert.equal(settled.totalOutput, 30);
});

test("8.2: branch switch (session_tree) recomputes from the new branch — no stale carryover", () => {
	const tracker = new UsageTracker();
	tracker.observe([assistant({ input: 100, output: 25, cost: 0.01 })]);
	const switched = tracker.observe([assistant({ input: 10, output: 2, cost: 0.001 })]);
	assert.equal(switched.used, 12);
	assert.equal(switched.cost, 0.001);
	assert.equal(switched.totalInput, 10);
	assert.equal(switched.totalOutput, 2);
});

test("8.2: compaction-replaced branch recomputes (compaction summary carries no usage)", () => {
	const tracker = new UsageTracker();
	tracker.observe([assistant({ input: 100, output: 25, cost: 0.01 })]);
	const compacted = tracker.observe([
		{ type: "compactionSummary", message: { role: "assistant", content: "summary" } },
		assistant({ input: 5, output: 1, cost: 0 }),
	]);
	assert.equal(compacted.used, 6);
	assert.equal(compacted.cost, 0);
});

test("8.2: observation points pin the verified host contract", () => {
	assert.deepEqual([...USAGE_OBSERVATION_POINTS], [
		"message_end",
		"agent_settled",
		"session_start",
		"session_tree",
		"session_compact",
	]);
});
