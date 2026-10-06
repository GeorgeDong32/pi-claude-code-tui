import assert from "node:assert/strict";
import test from "node:test";

import {
	formatObsPackedAnnotation,
	formatObsSavingsStatus,
	obsPackedAnnotationForCall,
	readObsSites,
	currentObsSavingsFlash,
	startObsSavingsConsumer,
	stopObsSavingsConsumer,
	type ObsSavingsTimer,
} from "../extensions/lib/obs-savings.ts";

/**
 * OBS-09 per-site savings consumer (upstream SoL-Pi showSolPiSavings
 * semantics): on each snapshot publish where `observation.sites` is a NEW
 * non-empty array, flash one host status line for 4s, then clear. The
 * observation channel persists between publishes, so re-delivered (old)
 * arrays must not re-flash. Absent channel → silent. Never throws.
 */

type Status = Record<string, string | undefined>;

function makeEnv() {
	const status: Status = {};
	const calls: Array<() => void> = [];
	const cleared: unknown[] = [];
	const timer: ObsSavingsTimer = {
		set(fn) {
			calls.push(fn);
			return { unref() {} };
		},
		clear(handle) {
			cleared.push(handle);
		},
	};
	const setStatus = (key: string, text: string | undefined) => {
		status[key] = text;
	};
	return { status, setStatus, timer, calls, cleared };
}

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

test("flash: new sites set the status line and clear after 4s", () => {
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	assert.equal(startObsSavingsConsumer(env.setStatus, store, env.timer), true);
	// already attached → idempotent
	assert.equal(startObsSavingsConsumer(env.setStatus, store, env.timer), true);

	listeners[0]!();
	assert.equal(env.status["cc-obs-savings"], undefined, "no sites yet");

	(store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } }).observation = { sites: [site("obs_a", 12345)] };
	listeners[0]!();
	assert.equal(env.status["cc-obs-savings"], "⚡ Observation Pack · 12,345 context tokens avoided");
	assert.equal(env.calls.length, 1, "one clear scheduled");

	// unrelated publish re-delivers the same array → no re-flash
	listeners[0]!();
	assert.equal(env.calls.length, 1);

	assert.equal(currentObsSavingsFlash(Date.now() + 1_000), "⚡ Observation Pack · 12,345 context tokens avoided");
	assert.equal(currentObsSavingsFlash(Date.now() + 5_000), null, "expired after 4s");
	env.calls[0]!();
	assert.equal(env.status["cc-obs-savings"], undefined);
	assert.equal(currentObsSavingsFlash(Date.now() + 1_000), null, "cleared with the timer");
	stopObsSavingsConsumer();
});

test("flash: multiple sites in one request combine into one line", () => {
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	startObsSavingsConsumer(env.setStatus, store, env.timer);
	(store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } }).observation = {
		sites: [site("obs_a", 12000), site("obs_b", 45678, "read")],
	};
	listeners[0]!();
	assert.equal(env.status["cc-obs-savings"], "⚡ Observation Pack · 2 packed results · 57,678 context tokens avoided");
	stopObsSavingsConsumer();
});

test("flash: a genuinely new array replaces the running flash (timer reset)", () => {
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	startObsSavingsConsumer(env.setStatus, store, env.timer);
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [site("obs_a", 10)] };
	listeners[0]!();
	channel.observation = { sites: [site("obs_a", 10), site("obs_b", 20)] };
	listeners[0]!();
	assert.equal(env.status["cc-obs-savings"], "⚡ Observation Pack · 2 packed results · 30 context tokens avoided");
	assert.equal(env.calls.length, 2);
	assert.equal(env.cleared.length, 1, "previous timer cleared");
	stopObsSavingsConsumer();
});

test("flash: attach fast-forwards past pre-existing sites (stale history)", () => {
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith([site("obs_old", 999)], listeners);
	startObsSavingsConsumer(env.setStatus, store, env.timer);
	listeners[0]!(); // re-delivered persisted array
	assert.equal(env.status["cc-obs-savings"], undefined, "history is not flashed");
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [site("obs_new", 5)] };
	listeners[0]!();
	assert.equal(env.status["cc-obs-savings"], "⚡ Observation Pack · 5 context tokens avoided");
	stopObsSavingsConsumer();
});

test("flash: malformed channel entries are skipped, never throw", () => {
	assert.deepEqual(readObsSites({ __piClaudeCodeCore: { observation: { sites: ["junk", null, { tool: 1 }, site("obs_a", 1)] } } }), [site("obs_a", 1)]);
	assert.deepEqual(readObsSites({}), []);
	assert.deepEqual(readObsSites({ __piClaudeCodeCore: { observation: {} } }), []);
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	startObsSavingsConsumer(env.setStatus, store, env.timer);
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [{ tool: "bash", id: "obs_x", avoidedTokens: "NaN" }] };
	listeners[0]!(); // all entries malformed → treated as empty → silent
	assert.equal(env.status["cc-obs-savings"], undefined);
	stopObsSavingsConsumer();
});

test("flash: no onChange (old core / not loaded) returns false, silent", () => {
	const env = makeEnv();
	assert.equal(startObsSavingsConsumer(env.setStatus, {}, env.timer), false);
	assert.deepEqual(env.status, {});
	stopObsSavingsConsumer();
});

test("format: matches upstream formatSavingsCount (en-US integer)", () => {
	assert.equal(formatObsSavingsStatus([site("obs_a", 12345.6)]), "⚡ Observation Pack · 12,346 context tokens avoided");
	assert.equal(formatObsSavingsStatus([]), "⚡ Observation Pack · 0 context tokens avoided");
});

test("packed annotation: joined by toolCallId, formatted compactly", () => {
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	startObsSavingsConsumer(env.setStatus, store, env.timer);
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [{ tool: "read", id: "obs_d2d080c18f1be74f1428df79", avoidedTokens: 12476, toolCallId: "call_abc" }] };
	listeners[0]!();
	assert.deepEqual(obsPackedAnnotationForCall("call_abc"), { tokens: 12476, id: "obs_d2d080c18f1be74f1428df79" });
	assert.equal(obsPackedAnnotationForCall("call_other"), undefined);
	assert.equal(formatObsPackedAnnotation(obsPackedAnnotationForCall("call_abc")!), "⚡ packed · 12.5k context tokens avoided · obs_d2d080c18f1b…");
	stopObsSavingsConsumer();
	assert.equal(obsPackedAnnotationForCall("call_abc"), undefined, "registry cleared on stop");
});

test("packed annotation: sites without toolCallId (old core) stay join-less", () => {
	const env = makeEnv();
	const listeners: Array<() => void> = [];
	const store = snapshotWith(undefined, listeners);
	startObsSavingsConsumer(env.setStatus, store, env.timer);
	const channel = store.__piClaudeCodeCore as { observation?: { sites?: unknown[] } };
	channel.observation = { sites: [{ tool: "read", id: "obs_a", avoidedTokens: 100 }] };
	listeners[0]!();
	assert.equal(obsPackedAnnotationForCall("call_abc"), undefined);
	assert.equal(env.status["cc-obs-savings"], "⚡ Observation Pack · 100 context tokens avoided", "flash still works");
	stopObsSavingsConsumer();
});
