import assert from "node:assert/strict";
import test from "node:test";

import {
	readObsSites,
	startObsSavingsConsumer,
	stopObsSavingsConsumer,
} from "../extensions/lib/obs-savings.ts";

/**
 * OBS-09-SITES consumer: on each genuinely-new first-replacement publish,
 * hand the sites to the callback (the entry appends a display-only session
 * entry). The observation channel persists in the snapshot between
 * publishes, so re-delivered (old) arrays must not re-fire. Absent channel
 * → false (silent). Callback throws are swallowed.
 */

function snapshotWith(sites: unknown[] | undefined, listeners: Array<() => void>) {
	return {
		__piClaudeCodeCore: {
			onChange(fn: () => void) {
				listeners.push(fn);
				return () => {};
			},
			...(sites === undefined ? {} : { observation: { sites } }),
		},
	};
}

function site(id: string, tokens: number, tool = "bash") {
	return { tool, id, avoidedTokens: tokens };
}

test("consumer: new sites fire the callback once; re-delivery is deduped", () => {
	const calls: unknown[][] = [];
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	assert.equal(startObsSavingsConsumer((s) => calls.push(s), store), true);
	assert.equal(startObsSavingsConsumer((s) => calls.push(s), store), true, "idempotent once attached");
	listeners[0]!();
	assert.deepEqual(calls, [], "empty channel fires nothing");
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [site("obs_a", 100)] };
	listeners[0]!();
	assert.deepEqual(calls, [[site("obs_a", 100)]]);
	listeners[0]!(); // unrelated publish re-delivers the same array
	assert.deepEqual(calls, [[site("obs_a", 100)]]);
	channel.observation = { sites: [site("obs_a", 100), site("obs_b", 50, "read")] };
	listeners[0]!();
	assert.deepEqual(calls, [[site("obs_a", 100)], [site("obs_a", 100), site("obs_b", 50, "read")]], "genuinely new array fires");
	stopObsSavingsConsumer();
});

test("consumer: callback exceptions never break the subscription", () => {
	const calls: unknown[][] = [];
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	let throwing = true;
	startObsSavingsConsumer((s) => {
		calls.push(s);
		if (throwing) throw new Error("boom");
	}, store);
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [site("obs_a", 1)] };
	listeners[0]!(); // throws inside — swallowed
	channel.observation = { sites: [site("obs_b", 2)] };
	listeners[0]!();
	throwing = false;
	channel.observation = { sites: [site("obs_c", 3)] };
	listeners[0]!();
	assert.equal(calls.length, 3, "subscription survived the throw");
	stopObsSavingsConsumer();
});

test("consumer: no onChange (old core / not loaded) returns false, silent", () => {
	const calls: unknown[][] = [];
	assert.equal(startObsSavingsConsumer((s) => calls.push(s), {}), false);
	assert.deepEqual(calls, []);
	stopObsSavingsConsumer();
});

test("readObsSites: malformed channel entries are skipped, never throw", () => {
	assert.deepEqual(readObsSites({ __piClaudeCodeCore: { observation: { sites: ["junk", null, { tool: 1 }, site("obs_a", 1), { tool: "read", id: "obs_b", avoidedTokens: 2, toolCallId: "call_x" }] } } }), [site("obs_a", 1), { tool: "read", id: "obs_b", avoidedTokens: 2, toolCallId: "call_x" }]);
	assert.deepEqual(readObsSites({}), []);
	assert.deepEqual(readObsSites({ __piClaudeCodeCore: { observation: {} } }), []);
});
