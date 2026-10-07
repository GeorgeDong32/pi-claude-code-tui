/** B7 channel tests: priority chain, version gating, legacy fallbacks. */
import test from "node:test";
import assert from "node:assert/strict";

import {
	PM_MODE_ENV,
	createNotificationAdapter,
	publishCcTuiCapability,
	readPmStatus,
} from "../extensions/lib/pm-capability.ts";
import { createCoreBusClient, type CoreBusAdapter } from "../extensions/lib/core-bus.ts";

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

// ---- client-based lifecycle (P0-2): presence + notification adapter -----

interface TestBus {
	store: Record<string, unknown>;
	listeners: Array<() => void>;
	publish(patch: Record<string, unknown>): void;
}

const newBus = (initial: Record<string, unknown> = {}): TestBus => {
	const listeners: Array<() => void> = [];
	const store: Record<string, unknown> = {
		__piClaudeCodeCore: {
			version: 2,
			onChange: (fn: () => void) => {
				listeners.push(fn);
				return () => {
					const idx = listeners.indexOf(fn);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
			notifications: [] as Array<{ id: number; level: string; msg: string }>,
			...initial,
		},
	};
	return {
		store,
		listeners,
		publish(patch) {
			Object.assign(store.__piClaudeCodeCore as Record<string, unknown>, patch);
			for (const listener of [...listeners]) listener();
		},
	};
};

const wireNotifications = (store: Record<string, unknown>, shown: Array<[string, string]>, adapters: CoreBusAdapter[] = []) => {
	const client = createCoreBusClient({
		store,
		adapters: [...adapters, createNotificationAdapter((msg, level) => shown.push([msg, level]))],
	});
	return client;
};

test("presence publish keeps both keys in sync (direct probe helper)", () => {
	const store: Record<string, unknown> = {};
	publishCcTuiCapability(store);
	assert.equal((store.__piCcTui as { active: boolean }).active, true);
	assert.equal(store.__ccTuiActive, true);
	delete store.__piCcTui;
	delete store.__ccTuiActive;
});

test("P0-2: client activate declares presence; close withdraws exactly our keys", () => {
	const bus = newBus();
	const client = wireNotifications(bus.store, [], [{ onAttach() {}, onDetach() {} }]);
	client.activate();
	assert.deepEqual((bus.store.__piCcTui as Record<string, unknown>).notificationsConsumer, true);
	assert.equal(bus.store.__ccTuiActive, true);
	assert.ok(bus.listeners.length >= 1, "attached");
	client.close();
	assert.equal(bus.store.__piCcTui, undefined, "presence withdrawn at close");
	assert.equal(bus.store.__ccTuiActive, undefined);
	assert.equal(bus.listeners.length, 0, "unsubscribed at close");
});

test("P0-2/B3: same bus — cursor starts at the declaration id (fallback-shown history not replayed)", () => {
	const bus = newBus({ notifications: [{ id: 1, level: "warning", msg: "shown by fallback" }] });
	const shown: Array<[string, string]> = [];
	const client = wireNotifications(bus.store, shown);
	client.activate(); // declaration sees max id 1 → cursor 1
	assert.deepEqual(shown, [], "history the fallback already displayed is not replayed");
	bus.publish({ notifications: [{ id: 1, level: "warning", msg: "shown by fallback" }, { id: 2, level: "info", msg: "fresh" }] });
	assert.deepEqual(shown, [["fresh", "info"]]);
	bus.publish({}); // idempotent redelivery
	assert.deepEqual(shown, [["fresh", "info"]]);
	client.close();
});

test("P0-2/B3: handoff window — items published between declaration and attach show exactly once", () => {
	const bus = newBus();
	const shown: Array<[string, string]> = [];
	const client = wireNotifications(bus.store, shown);
	// Startup window (cctui-first): declaration happens with NO bus; core
	// publishes while presence is live (nobody else displays); attach comes
	// at the next retry point.
	const store = bus.store;
	const detached = createCoreBusClient({
		store,
		adapters: [createNotificationAdapter((msg, level) => shown.push([msg, level]))],
	});
	void detached;
	void client;
	// Direct: declare before the bus exists, then bring the bus up.
	const fresh: Record<string, unknown> = {};
	const early = createCoreBusClient({
		store: fresh,
		adapters: [createNotificationAdapter((msg, level) => shown.push([msg, level]))],
	});
	early.activate(); // no snapshot at all
	assert.deepEqual(shown, []);
	// Core loads and its session_start notification lands while presence is live.
	const listeners: Array<() => void> = [];
	fresh.__piClaudeCodeCore = {
		version: 2,
		onChange: (fn: () => void) => {
			listeners.push(fn);
			return () => {
				const idx = listeners.indexOf(fn);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
		notifications: [{ id: 1, level: "warning", msg: "--effort unknown level" }],
	};
	early.retry(); // next retry point attaches
	assert.deepEqual(shown, [["--effort unknown level", "warning"]], "handoff window item shown exactly once");
	early.close();
	client.close();
	detached.close();
});

test("P0-2/B3: bus change — the new bus's queue replays from 0 (it was never displayed)", () => {
	const bus1 = newBus();
	const shown: Array<[string, string]> = [];
	const client = wireNotifications(bus1.store, shown, [{ onAttach() {}, onDetach() {} }]);
	client.activate();
	// Reload: the snapshot on the store is replaced wholesale by a NEW bus
	// (fresh register closure), carrying its own session_start queue.
	const listeners2: Array<() => void> = [];
	bus1.store.__piClaudeCodeCore = {
		version: 2,
		onChange: (fn: () => void) => {
			listeners2.push(fn);
			return () => {
				const idx = listeners2.indexOf(fn);
				if (idx >= 0) listeners2.splice(idx, 1);
			};
		},
		notifications: [{ id: 1, level: "warning", msg: "post-reload warning" }],
	};
	client.retry(); // detects the identity change, re-attaches
	assert.deepEqual(shown, [["post-reload warning", "warning"]]);
	client.close();
	assert.equal(listeners2.length, 0);
});

test("P0-2: late callbacks from an old generation deliver nothing", () => {
	const bus = newBus();
	const shown: Array<[string, string]> = [];
	const client = wireNotifications(bus.store, shown);
	client.activate();
	const staleListener = bus.listeners[0]!;
	client.close(); // generation invalidates it
	bus.publish({ notifications: [{ id: 1, level: "info", msg: "late" }] });
	staleListener(); // a straggler fires directly
	assert.deepEqual(shown, []);
});

test("P0-2: an old client's close never withdraws a NEWER instance's presence", () => {
	const bus = newBus();
	const a = wireNotifications(bus.store, []);
	const b = wireNotifications(bus.store, []);
	a.activate();
	b.activate(); // replaces the presence object
	assert.notEqual(bus.store.__piCcTui, undefined);
	a.close(); // stale close — must not touch b's keys
	assert.notEqual(bus.store.__piCcTui, undefined, "newer presence survives the old close");
	assert.equal(bus.store.__ccTuiActive, true);
	b.close();
	assert.equal(bus.store.__piCcTui, undefined);
	assert.equal(bus.store.__ccTuiActive, undefined);
});

test("P0-2: readPmStatus stays a pure read — constructing/activating is what subscribes", () => {
	const bus = newBus({ modes: { mode: "ask", workingStats: null } });
	assert.equal(bus.listeners.length, 0);
	readPmStatus(bus.store);
	readPmStatus(bus.store);
	assert.equal(bus.listeners.length, 0, "readPmStatus must not attach a subscription");
	const client = wireNotifications(bus.store, []);
	client.activate();
	assert.ok(bus.listeners.length >= 1);
	client.close();
	assert.equal(bus.listeners.length, 0);
});

test("P0-2/C9: repeated activate does not advance the baseline; cap overflow shows the visible tail", () => {
	const bus = newBus();
	const shown: Array<[string, string]> = [];
	const client = wireNotifications(bus.store, shown);
	client.activate();
	// Overflow the cap-20 tail: ids 1..25, only the last 20 remain visible.
	const queue = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, level: "info", msg: `m${i + 1}` }));
	bus.publish({ notifications: queue.slice(-20) });
	client.activate(); // repeated — must NOT re-truncate (items already shown stay shown)
	assert.equal(shown.length, 20, "visible tail consumed once");
	// A redelivered identical snapshot adds nothing.
	bus.publish({});
	assert.equal(shown.length, 20);
	client.close();
});

test("P0-2/C9: v1 snapshot (no onChange) and a corrupt snapshot stay safe and retryable", () => {
	const store: Record<string, unknown> = { __piClaudeCodeCore: { version: 1 } };
	const shown: Array<[string, string]> = [];
	const client = createCoreBusClient({ store, adapters: [createNotificationAdapter((m, l) => shown.push([m, l]))] });
	client.activate();
	assert.equal(client.retry(), false, "v1 is not subscribable");
	assert.deepEqual(shown, []);
	// Upgrade to v2 — retry attaches cleanly.
	const listeners: Array<() => void> = [];
	store.__piClaudeCodeCore = {
		version: 2,
		onChange: (fn: () => void) => {
			listeners.push(fn);
			return () => {
				const idx = listeners.indexOf(fn);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
		notifications: [{ id: 3, level: "error", msg: "boom" }],
	};
	assert.equal(client.retry(), true);
	assert.deepEqual(shown, [["boom", "error"]]);
	client.close();
});

test("P0-2/C9: malformed queue items are skipped, display throws do not block later items", () => {
	const bus = newBus();
	const shown: Array<[string, string]> = [];
	let throwOnce = true;
	const client = createCoreBusClient({
		store: bus.store,
		adapters: [
			createNotificationAdapter((msg, level) => {
				if (throwOnce && msg === "first") {
					throwOnce = false;
					throw new Error("stale ctx");
				}
				shown.push([msg, level]);
			}),
		],
	});
	client.activate();
	bus.publish({
		notifications: ["junk", null, { id: 1, level: "info", msg: "first" }, { id: 2, level: "info", msg: "second" }],
	});
	assert.deepEqual(shown, [["second", "info"]], "throwing item dropped (cursor advanced), later item shown");
	client.close();
});
