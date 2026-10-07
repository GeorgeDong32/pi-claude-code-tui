/**
 * Entry lifecycle tests (spec 2026-10-07 P0-1, E1/E2/E3/E6).
 *
 * These load the REAL extension factory and replace only the host surfaces
 * (pi / ctx / global bus snapshot) — the wiring itself (session_start →
 * enable, shutdown → teardown) is what's under test, not a helper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import factory from "../extensions/claude-code-tui.ts";
// Marker names live on the real pi component prototypes (spec 8.3 adapters).
import { UserMessageComponent, CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	SUBAGENT_PRESENTATION_PROTOCOL_VERSION,
	SUBAGENT_PRESENTATION_READY_EVENT,
	SUBAGENT_PRESENTATION_REGISTER_EVENT,
} from "../extensions/lib/subagent-presentation.ts";

interface RecordedUi {
	calls: Array<{ method: string; key?: string }>;
	notified: Array<{ msg: string; level: string }>;
}

const makeUi = (): { ui: Record<string, unknown>; rec: RecordedUi } => {
	const rec: RecordedUi = { calls: [], notified: [] };
	const ui = {
		notify: (msg: string, level: string) => rec.notified.push({ msg, level }),
		setHeader: (f: unknown) => rec.calls.push({ method: "setHeader", key: String(f) }),
		setTitle: () => rec.calls.push({ method: "setTitle" }),
		setWidget: (key: string, _content: unknown) => rec.calls.push({ method: "setWidget", key }),
		setFooter: (f: unknown) => rec.calls.push({ method: "setFooter", key: String(f) }),
		setEditorComponent: (f: unknown) => rec.calls.push({ method: "setEditorComponent", key: String(f) }),
		setHiddenThinkingLabel: () => rec.calls.push({ method: "setHiddenThinkingLabel" }),
		setWorkingIndicator: () => rec.calls.push({ method: "setWorkingIndicator" }),
		setWorkingMessage: () => rec.calls.push({ method: "setWorkingMessage" }),
		theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
	};
	return { ui, rec };
};

const makeCtx = (mode: "tui" | "rpc" = "tui") => {
	const { ui, rec } = makeUi();
	return {
		ctx: {
			mode,
			hasUI: mode === "tui",
			ui,
			model: { name: "GLM 5.3", id: "glm-5.3", provider: "zai", contextWindow: 200_000 },
			cwd: "/tmp/proj",
			sessionManager: { getSessionId: () => "s-1", getBranch: () => [] },
		} as never,
		rec,
	};
};

const makePi = () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const seamEvents = new Map<string, Array<(payload: unknown) => void>>();
	const seamEmitted: Array<[string, unknown]> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi: Record<string, unknown> = {
		on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		registerToolRenderer: () => {},
		registerEntryRenderer: () => {},
		registerMarkdownTransformer: () => {},
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, def),
		getAllTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => "medium",
		getFlag: () => undefined,
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		events: {
			on: (channel: string, fn: (payload: unknown) => void) => {
				const list = seamEvents.get(channel) ?? [];
				list.push(fn);
				seamEvents.set(channel, list);
				return () => {
					const current = seamEvents.get(channel) ?? [];
					const idx = current.indexOf(fn);
					if (idx >= 0) current.splice(idx, 1);
				};
			},
			emit: (channel: string, data: unknown) => {
				seamEmitted.push([channel, data]);
				for (const fn of [...(seamEvents.get(channel) ?? [])]) fn(data);
			},
		},
	};
	return {
		pi,
		entries,
		seamEmitted,
		commands,
		fire: async (event: string, ctx: unknown, payload: unknown = {}) => {
			for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
		},
		fireSeam: (channel: string, data: unknown) => {
			for (const fn of [...(seamEvents.get(channel) ?? [])]) fn(data);
		},
	};
};

/** Fake v2 bus snapshot on globalThis (the real seam the consumers read). */
const useFakeBus = () => {
	const g = globalThis as Record<string, unknown>;
	const listeners = new Set<() => void>();
	const state: { queue: Array<{ id: number; level: string; msg: string }>; sites: unknown } = { queue: [], sites: undefined };
	const snapshot: Record<string, unknown> = {
		onChange: (fn: () => void): (() => void) => {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
	};
	const refresh = () => {
		snapshot.version = 2;
		snapshot.notifications = state.queue;
		if (state.sites !== undefined) snapshot.observation = { sites: state.sites };
		g.__piClaudeCodeCore = snapshot;
	};
	refresh();
	return {
		listeners,
		notify: (msg: string, level = "info") => {
			const id = state.queue.length > 0 ? state.queue[state.queue.length - 1]!.id + 1 : 1;
			state.queue = [...state.queue, { id, level, msg }];
			refresh();
			for (const l of listeners) l();
		},
		publishSites: (sites: unknown) => {
			state.sites = sites;
			refresh();
			for (const l of listeners) l();
		},
		cleanup: () => {
			listeners.clear();
			delete g.__piClaudeCodeCore;
			delete g.__piCcTui;
			delete g.__ccTuiActive;
			delete g.__pmWorkingStats;
		},
	};
};

const patchedMarkers = (): string[] => {
	const found: string[] = [];
	const check = (proto: object, marker: string, label: string) => {
		if ((proto as Record<string, unknown>)[marker] !== undefined) found.push(label);
	};
	check((CompactionSummaryMessageComponent as { prototype: object }).prototype, "__ccRowsPatched", "compaction");
	check(UserMessageComponent.prototype, "__ccCompact", "user-bar");
	// (skill-row patches pi's SkillMessageComponent, which pi does not export
	// at top level — its marker is covered by cc-skill-row.test.ts instead)
	return found;
};

interface Harness {
	pi: ReturnType<typeof makePi>;
	bus: ReturnType<typeof useFakeBus>;
	rec: RecordedUi;
	ctx: never;
	agentDir: string;
	dispose: () => void;
}

const setup = (mode: "tui" | "rpc" = "tui"): Harness => {
	const agentDir = mkdtempSync(join(tmpdir(), "cc-tui-lifecycle-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.CC_TUI_TOOL_ROWS;
	const pi = makePi();
	const bus = useFakeBus();
	factory(pi.pi as never);
	const { ctx, rec } = makeCtx(mode);
	return {
		pi,
		bus,
		rec,
		ctx,
		agentDir,
		dispose: () => {
			// Leave nothing behind for the next test in this process: the
			// prototype patches and presence keys are process-global even
			// though each harness builds a fresh factory closure.
			void pi.fire("session_shutdown", ctx).catch(() => {});
			bus.cleanup();
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
};

const countCalls = (rec: RecordedUi, method: string, key?: string): number =>
	rec.calls.filter((c) => c.method === method && (key === undefined || c.key === key)).length;

// ---------------------------------------------------------------------------
// E1 — non-TUI guard (TUI-03)

test("E1: rpc session_start keeps everything stock — no presence, no patches, no entries, no notify", async () => {
	const h = setup("rpc");
	try {
		await h.pi.fire("session_start", h.ctx);
		const g = globalThis as Record<string, unknown>;
		assert.equal(g.__piCcTui, undefined, "presence must not be declared in rpc mode");
		assert.equal(g.__ccTuiActive, undefined, "legacy presence must not be set");
		assert.deepEqual(h.pi.entries, [], "no display entries in rpc mode");
		assert.deepEqual(patchedMarkers(), [], "no prototype patches in rpc mode");
		assert.deepEqual(h.rec.notified, [], "no notifications in rpc mode");
		assert.deepEqual(h.rec.calls, [], "no UI slot writes in rpc mode");
		// A later bus publish still reaches nobody: the consumers never started.
		h.bus.notify("late", "warning");
		h.bus.publishSites([{ tool: "read", id: "obs_1", avoidedTokens: 10 }]);
		assert.deepEqual(h.pi.entries, []);
	} finally {
		h.dispose();
	}
});

// ---------------------------------------------------------------------------
// E2 — shutdown teardown (TUI-04)

test("E2: tui session_start → session_shutdown withdraws presence, stops consumers, restores patches and header", async () => {
	const h = setup();
	try {
		await h.pi.fire("session_start", h.ctx);
		await sleep(5); // let the footer requeue macrotask settle (normal path)
		const g = globalThis as Record<string, unknown>;
		assert.notEqual(g.__piCcTui, undefined, "presence declared while enabled");
		assert.ok(h.bus.listeners.size >= 1, "bus consumers attached");
		assert.notDeepEqual(patchedMarkers(), [], "patches installed while enabled");
		assert.ok(countCalls(h.rec, "setHeader") >= 1, "header installed");
		const notifiedBefore = h.rec.notified.length;

		await h.pi.fire("session_shutdown", h.ctx);
		assert.equal(g.__piCcTui, undefined, "presence withdrawn at shutdown");
		assert.equal(g.__ccTuiActive, undefined, "legacy presence withdrawn at shutdown");
		assert.equal(h.bus.listeners.size, 0, "bus consumers unsubscribed at shutdown");
		assert.deepEqual(patchedMarkers(), [], "patches restored at shutdown");
		assert.ok(
			h.rec.calls.some((c) => c.method === "setHeader" && c.key === "undefined"),
			"setHeader(undefined) released the slot",
		);
		// Late bus traffic reaches nobody.
		const entriesBefore = h.pi.entries.length;
		h.bus.notify("post-shutdown", "warning");
		h.bus.publishSites([{ tool: "read", id: "obs_2", avoidedTokens: 5 }]);
		assert.equal(h.pi.entries.length, entriesBefore);
		assert.equal(h.rec.notified.length, notifiedBefore);
	} finally {
		h.dispose();
	}
});

test("E2b: bridge stop is observable — after shutdown a READY event no longer registers", async () => {
	const h = setup();
	try {
		await h.pi.fire("session_start", h.ctx);
		h.pi.seamEmitted.length = 0;
		h.pi.fireSeam(SUBAGENT_PRESENTATION_READY_EVENT, {
			protocol: SUBAGENT_PRESENTATION_PROTOCOL_VERSION,
			surfaces: ["fleet", "async"],
		});
		await sleep(5);
		assert.ok(
			h.pi.seamEmitted.some(([channel]) => channel === SUBAGENT_PRESENTATION_REGISTER_EVENT),
			"live bridge registers on READY",
		);
		await h.pi.fire("session_shutdown", h.ctx);
		h.pi.seamEmitted.length = 0;
		h.pi.fireSeam(SUBAGENT_PRESENTATION_READY_EVENT, {
			protocol: SUBAGENT_PRESENTATION_PROTOCOL_VERSION,
			surfaces: ["fleet", "async"],
		});
		await sleep(5);
		assert.ok(
			!h.pi.seamEmitted.some(([channel]) => channel === SUBAGENT_PRESENTATION_REGISTER_EVENT),
			"stopped bridge ignores READY (stop() reached it)",
		);
	} finally {
		h.dispose();
	}
});

// ---------------------------------------------------------------------------
// E3 — shutdown → session_start re-enables (same module instance, /new shape)

test("E3: shutdown then a fresh session_start re-declares presence, re-subscribes, re-patches", async () => {
	const h = setup();
	try {
		await h.pi.fire("session_start", h.ctx);
		await sleep(5);
		await h.pi.fire("session_shutdown", h.ctx);

		await h.pi.fire("session_start", h.ctx);
		await sleep(5);
		const g = globalThis as Record<string, unknown>;
		assert.notEqual(g.__piCcTui, undefined, "presence re-declared");
		assert.ok(h.bus.listeners.size >= 1, "subscriptions re-established");
		assert.notDeepEqual(patchedMarkers(), [], "patches re-installed");
		// Thinking tip fires once per factory (module state), not per session.
		assert.equal(h.rec.notified.filter((n) => n.msg.includes("toggles collapsed thinking")).length, 1);
	} finally {
		h.dispose();
	}
});

// ---------------------------------------------------------------------------
// E6 — footer requeue cancellation + teardown resilience

test("E6: teardown cancels the pending footer requeue — no stale widget reinstall, no old-ctx access", async () => {
	const h = setup();
	try {
		await h.pi.fire("session_start", h.ctx);
		assert.ok(countCalls(h.rec, "setWidget", "cc-status") >= 1);
		// Teardown BEFORE the macrotask fires.
		await h.pi.fire("session_shutdown", h.ctx);
		const callsAtTeardown = h.rec.calls.length;
		await sleep(10); // the cancelled requeue's slot
		assert.equal(h.rec.calls.length, callsAtTeardown, "cancelled requeue must not touch the UI later");
	} finally {
		h.dispose();
	}
});

test("E6b: a requeue firing after /claude-footer on does not reinstall cc-status", async () => {
	const h = setup();
	try {
		await h.pi.fire("session_start", h.ctx);
		// Toggle native footer while the enable-time requeue macrotask is
		// still pending: the callback's !showNativeFooter check must keep it
		// silent when it eventually fires.
		const footer = h.pi.commands.get("claude-footer");
		assert.ok(footer, "claude-footer command registered");
		await footer.handler("on", h.ctx);
		const widgetCalls = countCalls(h.rec, "setWidget", "cc-status");
		await sleep(10); // requeue macrotask fires here
		assert.equal(countCalls(h.rec, "setWidget", "cc-status"), widgetCalls, "stale requeue stayed silent");
	} finally {
		h.dispose();
	}
});

test("E6c: a throwing teardown step does not block the remaining releases", async () => {
	const h = setup();
	try {
		await h.pi.fire("session_start", h.ctx);
		await sleep(5);
		assert.notDeepEqual(patchedMarkers(), []);
		// Make the header step throw (e.g. a stale host slot write).
		const ui = (h.ctx as unknown as { ui: Record<string, unknown> }).ui;
		const original = ui.setHeader as () => void;
		ui.setHeader = () => {
			throw new Error("stale host");
		};
		await h.pi.fire("session_shutdown", h.ctx);
		ui.setHeader = original;
		const g = globalThis as Record<string, unknown>;
		assert.equal(g.__piCcTui, undefined, "earlier step (presence) completed");
		assert.deepEqual(patchedMarkers(), [], "later steps (patches) completed despite the throw");
		assert.equal(h.bus.listeners.size, 0, "consumers unsubscribed despite the throw");
	} finally {
		h.dispose();
	}
});
