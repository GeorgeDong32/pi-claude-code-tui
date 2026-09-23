/** B7 channel tests: priority chain, version gating, legacy fallbacks. */
import test from "node:test";
import assert from "node:assert/strict";

import {
	PM_MODE_ENV,
	publishCcTuiCapability,
	startCoreNotificationConsumer,
	stopCoreNotificationConsumer,
	readPmStatus,
	withdrawCcTuiCapability,
} from "../extensions/lib/pm-capability.ts";

const cap = (over: Record<string, unknown> = {}) => ({
	version: 1,
	active: true,
	mode: "auto",
	workingStats: "↑1.2k · ↓300",
	...over,
});

test("versioned capability wins; workingStats used verbatim", () => {
	const store: Record<string, unknown> = {
		__piPermissionModes: cap(),
		__pmWorkingStats: "(legacy)",
	};
	assert.deepEqual(readPmStatus(store), { workingStats: "↑1.2k · ↓300", mode: "auto" });
});

test("DC1: mode meta from the projection is passed through (single source)", () => {
	const meta = {
		ask: { icon: "●", label: "Ask", role: "muted" },
		bypass: { icon: "⚡", label: "Bypass", role: "error" },
	};
	const store: Record<string, unknown> = {
		__piPermissionModes: cap({ meta }),
	};
	const status = readPmStatus(store);
	assert.equal(status.meta, meta); // by reference — frozen snapshot reuse
	assert.equal(status.meta?.bypass?.icon, "⚡");
});

test("DC1: absent meta keeps the historical two-field shape", () => {
	const store: Record<string, unknown> = { __piPermissionModes: cap() };
	const status = readPmStatus(store);
	assert.deepEqual(Object.keys(status).sort(), ["mode", "workingStats"]);
});

test("capability with empty stats falls back to legacy key (paren-stripped)", () => {
	const store: Record<string, unknown> = {
		__piPermissionModes: cap({ workingStats: null }),
		__pmWorkingStats: "(↑9 · ↓9)",
	};
	assert.deepEqual(readPmStatus(store), { workingStats: "↑9 · ↓9", mode: "auto" });
});

test("unversioned capability is ignored — pure legacy path", () => {
	process.env[PM_MODE_ENV] = "plan";
	try {
		const store: Record<string, unknown> = {
			__piPermissionModes: { active: true }, // no version
			__pmWorkingStats: "(↑1)",
		};
		assert.deepEqual(readPmStatus(store), { workingStats: "↑1", mode: "plan" });
	} finally {
		delete process.env[PM_MODE_ENV];
	}
});

test("no channel at all yields empty status", () => {
	assert.deepEqual(readPmStatus({}), { workingStats: "", mode: "" });
});

test("cc-tui presence publish/withdraw keeps both keys in sync", () => {
	const store: Record<string, unknown> = {};
	publishCcTuiCapability(store);
	assert.equal((store.__piCcTui as { active: boolean }).active, true);
	assert.equal(store.__ccTuiActive, true);
	withdrawCcTuiCapability(store);
	assert.equal(store.__piCcTui, undefined);
	assert.equal(store.__ccTuiActive, undefined);
});

test("DC5: the bus snapshot itself is the primary source", () => {
	const meta = { ask: { icon: "●", label: "Ask", role: "muted" } };
	const store: Record<string, unknown> = {
		__piClaudeCodeCore: { version: 2, revision: 3, modes: { mode: "bypass", workingStats: "↑7", meta } },
		__piPermissionModes: cap({ mode: "ask", workingStats: "old" }),
	};
	assert.deepEqual(readPmStatus(store), { workingStats: "↑7", mode: "bypass", meta });
});

test("DC5: null snapshot stats falls back through to the legacy key", () => {
	const store: Record<string, unknown> = {
		__piClaudeCodeCore: { version: 2, revision: 3, modes: { mode: "auto", workingStats: null } },
		__pmWorkingStats: "(↑3)",
	};
	assert.deepEqual(readPmStatus(store), { workingStats: "↑3", mode: "auto" });
});

test("DC5b: capability declares notificationsConsumer", () => {
	const store: Record<string, unknown> = {};
	publishCcTuiCapability(store);
	assert.deepEqual((store.__piCcTui as Record<string, unknown>).notificationsConsumer, true);
	withdrawCcTuiCapability(store);
	assert.equal(store.__piCcTui, undefined);
});

test("DC5b: consumer subscribes via snapshot onChange and diffs by lastSeenId (fast-forward, no replay)", async () => {
	const store: Record<string, unknown> = {};
	const listeners = new Set<() => void>();
	let queue: Array<{ id: number; level: string; msg: string }> = [];
	// v1 snapshot first — subscription must return false, then succeed on v2.
	function makeSnap(withOnChange: boolean) {
		return withOnChange
			? { version: 2, onChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); }, notifications: queue }
			: { version: 1, notifications: queue };
	}
	store.__piClaudeCodeCore = makeSnap(false);
	const shown: Array<[string, string]> = [];
	assert.equal(startCoreNotificationConsumer((m, l) => shown.push([m, l]), store), false);
	// Upgrade to v2 with pre-existing history (id 1) — attaching must not replay it.
	stopCoreNotificationConsumer(); // isolate from prior tests (module singleton)
	queue = [{ id: 1, level: "info", msg: "history" }];
	store.__piClaudeCodeCore = makeSnap(true);
	assert.equal(startCoreNotificationConsumer((m, l) => shown.push([m, l]), store), true);
	assert.deepEqual(shown, []); // fast-forwarded past id 1
	// A publish appends and fires listeners — only the new item shows.
	// (The snapshot must be re-issued so its notifications ref sees the queue.)
	queue = [...queue, { id: 2, level: "warning", msg: "fresh" }];
	store.__piClaudeCodeCore = makeSnap(true);
	for (const l of listeners) l();
	assert.deepEqual(shown, [["fresh", "warning"]]);
	// Redelivery of the same snapshot is idempotent.
	for (const l of listeners) l();
	assert.deepEqual(shown, [["fresh", "warning"]]);
	stopCoreNotificationConsumer();
	assert.equal(listeners.size, 0);
});

test("DC5b: readPmStatus retries the pending subscription idempotently", () => {
	const store: Record<string, unknown> = {};
	const listeners = new Set<() => void>();
	store.__piClaudeCodeCore = {
		version: 2,
		onChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
		notifications: [],
		modes: { mode: "ask", workingStats: null },
	};
	const shown: Array<[string, string]> = [];
	stopCoreNotificationConsumer(); // isolate from prior tests (module singleton)
	startCoreNotificationConsumer((m, l) => shown.push([m, l]), store);
	readPmStatus(store); // frame-path retry hook — already subscribed, no double
	readPmStatus(store);
	assert.equal(listeners.size, 1);
	stopCoreNotificationConsumer();
});
