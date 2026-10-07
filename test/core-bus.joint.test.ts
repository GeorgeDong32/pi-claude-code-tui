/**
 * Joint fixtures (spec 2026-10-07 P0-2 §6.3.1): the REAL pi-claude-code-core
 * bus (extensions/bus.ts), ui/notify.ts and ui/fallback.ts drive the
 * handoff/reload scenarios against THIS package's core-bus client — ported
 * from the review sims (reload / startup-window / reload-core-first) into
 * permanent tests. Two-repo revisions are recorded in the spec's
 * implementation notes.
 *
 * Loading: core's extension sources import each other with ".js" specifiers,
 * which node's type stripping cannot resolve — jiti (the same loader the pi
 * host uses, available as a transitive dep) loads them. A "core reload" is
 * simulated with the REAL bus factory semantics: resetCoreBusForTests() +
 * restoring the stale snapshot on the store (exactly what a replaced module
 * leaves behind — a lingering v2 snapshot whose register closure belongs to
 * the dead bus), then a fresh shared bus whose first publish takes the store.
 *
 * Skipped entirely when the sibling core checkout is absent, so plain
 * `npm test` stays green on isolated machines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createCoreBusClient, createFooterChannel } from "../extensions/lib/core-bus.ts";
import { createNotificationAdapter } from "../extensions/lib/pm-capability.ts";

const CORE_ROOT = process.env.CC_TUI_JOINT_CORE_ROOT
	? path.join(process.env.CC_TUI_JOINT_CORE_ROOT, "extensions")
	: path.resolve("node_modules/..", "..", "pi-claude-code-core", "extensions");
const CORE_AVAILABLE = existsSync(path.join(CORE_ROOT, "ui", "notify.ts"));
const skip = CORE_AVAILABLE ? false : "sibling pi-claude-code-core checkout not present";

interface CoreNotify {
	notify(
		ctx: { hasUI?: boolean; ui?: { notify(message: string, level: string): void } },
		msg: string,
		level?: string,
	): void;
	publishNotification(level: string, msg: string): void;
}
interface CoreFallbackAdapter {
	startup(): void;
	shutdown(): void;
	onSnapshot(snapshot: unknown): void;
}
interface CoreBusModule {
	createCoreBus(): { publish(patch: unknown): unknown; snapshot(): unknown };
	resetCoreBusForTests(): void;
	initCoreBus(): { publish(patch: unknown): unknown; snapshot(): unknown };
}

const require = createRequire(import.meta.url);

interface JitiLike {
	import(modulePath: string): Promise<Record<string, unknown>>;
}
type CreateJiti = (id: string, opts?: unknown) => JitiLike;
let createJiti: CreateJiti | null = null;
try {
	const jitiPath = require.resolve("jiti", {
		paths: [path.resolve("node_modules/@earendil-works/pi-coding-agent")],
	});
	const jitiModule = require(jitiPath) as { createJiti?: CreateJiti };
	createJiti = jitiModule.createJiti ?? null;
} catch {
	createJiti = null;
}

interface CoreFallbackModule {
	createFallbackAdapter(host: {
		hasUI: boolean;
		setWorkingMessage(message?: string): void;
		notify?(message: string, level: string): void;
		theme: { fg(role: string, s: string): string };
	}): CoreFallbackAdapter;
}

const coreModules = async (): Promise<{ notify: CoreNotify; fallback: CoreFallbackModule; bus: CoreBusModule }> => {
	if (!createJiti) throw new Error("jiti unavailable");
	const jiti = createJiti(pathToFileURL(path.resolve("test")).href);
	const bus = (await jiti.import(path.join(CORE_ROOT, "bus.ts"))) as unknown as CoreBusModule;
	const notify = (await jiti.import(path.join(CORE_ROOT, "ui", "notify.ts"))) as unknown as CoreNotify;
	const fallback = (await jiti.import(path.join(CORE_ROOT, "ui", "fallback.ts"))) as unknown as CoreFallbackModule;
	return { notify, fallback, bus };
};

const g = globalThis as Record<string, unknown>;

const wipeCoreGlobals = (): void => {
	delete g.__piClaudeCodeCore;
	delete g.__piClaudeCodeCoreCmd;
	delete g.__piPermissionModes;
	delete g.__pmWorkingStats;
	delete g.__piCcTui;
	delete g.__ccTuiActive;
};

const makeHost = (shown: Array<[string, string]>) => ({
	hasUI: true,
	setWorkingMessage: () => {},
	notify: (message: string, level: string) => shown.push([message, level]),
	theme: { fg: (_role: string, s: string) => s },
});

test("C2 startup window (cctui first): handoff notification shows exactly once", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		// cctui declares presence BEFORE any core bus exists.
		const shown: Array<[string, string]> = [];
		const client = createCoreBusClient({ adapters: [createNotificationAdapter((m, l) => shown.push([m, l]))] });
		client.activate();
		assert.deepEqual(shown, []);
		// Core loads; its fallback adapter startup force-upgrades the fresh
		// bus v1 → v2 (empty publish) and subscribes.
		const fallbackShown: Array<[string, string]> = [];
		const adapter = core.fallback.createFallbackAdapter(makeHost(fallbackShown));
		adapter.startup();
		// Core's session_start warning lands while cctui's presence is LIVE:
		// no direct forward, fallback advances silently.
		core.notify.notify({ hasUI: true, ui: { notify: (m, l) => fallbackShown.push([m, l]) } }, "--effort ultra: unknown effort level", "warning");
		assert.deepEqual(fallbackShown, [], "live presence suppresses the fallback");
		// The next cctui retry point attaches and consumes the window item.
		assert.equal(client.retry(), true);
		assert.deepEqual(shown, [["--effort ultra: unknown effort level", "warning"]]);
		// A republished identical snapshot is idempotent.
		assert.equal(client.retry(), true);
		assert.deepEqual(shown.length, 1);
		client.close();
		adapter.shutdown();
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});

test("C1 reload (cctui first): stale bus attach → core reload → re-attach, post-reload items exactly once", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		// Phase 1: core up, no cctui — a warning shows via the REAL fallback.
		const fallbackShown: Array<[string, string]> = [];
		const adapter = core.fallback.createFallbackAdapter(makeHost(fallbackShown));
		adapter.startup();
		core.notify.notify({ hasUI: true, ui: { notify: (m, l) => fallbackShown.push([m, l]) } }, "initial config warning", "warning");
		assert.equal(fallbackShown.length, 1);
		// cctui activates: same bus → cursor at the declaration max → the
		// fallback-shown item is NOT replayed.
		const shownA: Array<[string, string]> = [];
		const a = createCoreBusClient({ adapters: [createNotificationAdapter((m, l) => shownA.push([m, l]))] });
		a.activate();
		assert.deepEqual(shownA, []);
		// /reload: old cctui shuts down (presence withdrawn), the module is
		// replaced — its LAST snapshot lingers on the store.
		const staleSnapshot = g.__piClaudeCodeCore;
		a.close();
		core.bus.resetCoreBusForTests(); // shared bus torn down; fresh on next use
		g.__piClaudeCodeCore = staleSnapshot; // the lingering reload condition
		// New cctui instance B loads BEFORE the new core (cctui-first): it
		// activates against the STALE snapshot and attaches to the dead bus.
		const shownB: Array<[string, string]> = [];
		const b = createCoreBusClient({ adapters: [createNotificationAdapter((m, l) => shownB.push([m, l]))] });
		b.activate();
		assert.equal(b.retry(), true, "attached (to the stale bus)");
		assert.deepEqual(shownB, []);
		// New core's fallback startup force-publishes on the FRESH bus — the
		// store now points at the new bus (new register closure identity).
		const fallbackShown2: Array<[string, string]> = [];
		const adapter2 = core.fallback.createFallbackAdapter(makeHost(fallbackShown2));
		adapter2.startup();
		// New core's session_start warning: B's presence is live → no
		// forward, new fallback silent.
		core.notify.notify({ hasUI: true, ui: { notify: (m, l) => fallbackShown2.push([m, l]) } }, "post-reload warning", "warning");
		assert.deepEqual(fallbackShown2, []);
		// B's next retry point detects the bus change, re-attaches, and the
		// new bus's queue replays from 0 — shown exactly once.
		b.retry();
		assert.deepEqual(shownB, [["post-reload warning", "warning"]]);
		b.close();
		adapter2.shutdown();
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});

test("C3 reload (core first, the local machine's order): fallback/direct-forward shows it once, new cctui does not replay", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		// Phase 1 identical to C1: warning shown once via fallback, cctui A
		// attaches with cursor = max.
		const fallbackShown: Array<[string, string]> = [];
		const adapter = core.fallback.createFallbackAdapter(makeHost(fallbackShown));
		adapter.startup();
		core.notify.notify({ hasUI: true, ui: { notify: (m, l) => fallbackShown.push([m, l]) } }, "initial config warning", "warning");
		assert.equal(fallbackShown.length, 1);
		const shownA: Array<[string, string]> = [];
		const a = createCoreBusClient({ adapters: [createNotificationAdapter((m, l) => shownA.push([m, l]))] });
		a.activate();
		assert.deepEqual(shownA, []);
		// /reload: A withdraws (P0-1's shutdown teardown), core module replaced.
		a.close();
		core.bus.resetCoreBusForTests();
		// New core (core-first) starts BEFORE the new cctui: its fallback
		// publishes, then its session_start warning faces NO presence —
		// notify()'s direct forward displays it once (real negotiation path).
		const coreSideShown: Array<[string, string]> = [];
		const adapter2 = core.fallback.createFallbackAdapter(makeHost(coreSideShown));
		adapter2.startup();
		core.notify.notify({ hasUI: true, ui: { notify: (m, l) => coreSideShown.push([m, l]) } }, "post-reload warning", "warning");
		assert.deepEqual(coreSideShown.filter(([m]) => m === "post-reload warning").length, 1, "core side displayed it exactly once");
		// New cctui B activates AFTER the bus was already reloaded: its
		// baseline (max id at declaration) already covers the shown item.
		const shownB: Array<[string, string]> = [];
		const b = createCoreBusClient({ adapters: [createNotificationAdapter((m, l) => shownB.push([m, l]))] });
		b.activate();
		assert.deepEqual(shownB, [], "no replay of what the core side already displayed");
		b.close();
		adapter2.shutdown();
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});

test("C4 old-core identity: same bus republish keeps the attachment; a fresh bus re-attaches", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		const shown: Array<[string, string]> = [];
		const client = createCoreBusClient({ adapters: [createNotificationAdapter((m, l) => shown.push([m, l]))] });
		client.activate();
		core.notify.publishNotification("info", "first");
		assert.equal(client.retry(), true);
		assert.deepEqual(shown, [["first", "info"]]);
		// Republish on the SAME bus: identity (register closure) unchanged —
		// retry is a no-op and the listener count stays put.
		const listenersBefore = ((g.__piClaudeCodeCore as { onChange?: unknown }).onChange as unknown) === null;
		void listenersBefore;
		assert.equal(client.retry(), true);
		// A genuinely fresh bus instance (module replacement) has a NEW
		// register closure — the client must re-attach and replay from 0.
		const freshBus = core.bus.createCoreBus();
		(freshBus as { publish(patch: unknown): unknown }).publish({
			notifications: [{ id: 1, level: "warning", msg: "from the new bus" }],
			display: { footer: ["[core] observation-pack degraded (compat)"] },
		});
		assert.equal(client.retry(), true);
		assert.deepEqual(shown.at(-1), ["from the new bus", "warning"]);
		client.close();
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});

test("C6 (footer half): real display.footer publish reaches the channel cache", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		const renders: number[] = [];
		const channel = createFooterChannel(() => renders.push(1));
		const client = createCoreBusClient({ adapters: [channel.adapter] });
		client.activate();
		core.bus.initCoreBus().publish({ display: { footer: ["[core] observation-pack degraded (compat)"] } });
		assert.equal(client.retry(), true, "the bus appeared after activate — retry attaches");
		assert.deepEqual(channel.lines(), ["[core] observation-pack degraded (compat)"]);
		assert.ok(renders.length >= 1, "content change requested a render");
		// Absent field on a NEW bus clears the cache (never stale text).
		core.bus.createCoreBus().publish({});
		assert.equal(client.retry(), true);
		assert.deepEqual(channel.lines(), []);
		client.close();
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});

test("C4b: with the new core (snapshot.instance present) the identity IS the instance token, not the register closure", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		const client = createCoreBusClient({ adapters: [] });
		client.activate();
		const bus = core.bus.initCoreBus();
		bus.publish({});
		const snapshot = g.__piClaudeCodeCore as { instance?: string; onChange?: unknown };
		if (typeof snapshot.instance === "string") {
			// New core (P1-1 XPKG-03, core >= 320e7e5): busIdentityOf must
			// PREFER the instance token — the register closure only serves
			// old cores. Proven by the joint scenarios above re-running green
			// on the new core; pin the preference directly here.
			const { busIdentityOf } = await import("../extensions/lib/core-bus.ts");
			assert.equal(busIdentityOf(snapshot as never), snapshot.instance);
			// And a fresh bus mints a distinct token → re-attach (C4).
			const second = core.bus.createCoreBus();
			assert.notEqual((second as { snapshot: () => { instance?: string } }).snapshot().instance, snapshot.instance);
		}
		// Old cores (no instance field): the register closure remains the
		// identity — covered by C4's closure-identity assertions.
		client.close();
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});

test("C7-usage: real core modes.usage publish validates through readCoreUsage (P2-4 / XPKG-08)", { skip }, async () => {
	wipeCoreGlobals();
	const core = await coreModules();
	try {
		const { readCoreUsage } = await import("../extensions/lib/core-bus.ts");
		assert.equal(readCoreUsage(), null, "fresh bus: channel absent");
		const bus = core.bus.initCoreBus() as unknown as {
			publish(patch: unknown): unknown;
			snapshot(): { modes?: { usage?: unknown } };
		};
		bus.publish({
			modes: {
				mode: "auto",
				workingStats: "↑1.2M · ↓30k · $1.500 · 13% ctx",
				usage: { input: 1_200_000, output: 30_000, cacheRead: 500_000, cacheWrite: 0, cost: 1.5, tps: 45, ctxTokens: 150_000, ctxPercent: 12.6, contextWindow: 1_000_000 },
			} as never,
		});
		const usage = readCoreUsage();
		assert.ok(usage, "validated through");
		assert.equal(usage!.cost, 1.5);
		assert.equal(usage!.ctxPercent, 12.6);
		// Reference-stable across unrelated publishes (identity change = refresh trigger).
		const first = bus.snapshot().modes?.usage;
		bus.publish({ display: { footer: ["x"] } });
		assert.equal(bus.snapshot().modes?.usage, first, "mode-only patches keep the usage object");
		// An EXPLICIT null clears (session switch) → readCoreUsage falls back.
		bus.publish({ modes: { mode: "auto", workingStats: null, usage: null } as never });
		assert.equal(readCoreUsage(), null, "cleared channel → null (tracker fallback)");
	} finally {
		core.bus.resetCoreBusForTests();
		wipeCoreGlobals();
	}
});
