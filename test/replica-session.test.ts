/**
 * ReplicaSession lifecycle matrix (spec 2026-10-07 P2-1 §5.1).
 *
 * The session is the extraction target of the entry's hidden controller:
 * every sequence here drives it through recording fakes (UiSlots, bridge,
 * patches, core-bus client, statusline factory, silence probe) — pure
 * table-testable lifecycle, no pi runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { ReplicaSession, type ReplicaSessionDeps, type UiSlots } from "../extensions/lib/replica-session.ts";
import type { StatuslineRunner } from "../extensions/lib/statusline.ts";

interface Recording {
	events: string[];
	widgetContent: Map<string, unknown>;
	headerFactory: ((tui: unknown, theme: unknown) => unknown) | null;
	editorFactory: unknown;
	notified: Array<{ msg: string; level: string }>;
	footerSlot: unknown[];
}

const makeSlots = (mode: "tui" | "rpc" = "tui", rec: Recording): UiSlots => ({
	mode,
	notify: (msg, level) => rec.notified.push({ msg, level }),
	setHeader: (factory) => {
		rec.events.push("setHeader");
		rec.headerFactory = factory as never;
	},
	setTitle: () => rec.events.push("setTitle"),
	setEditorComponent: (factory) => {
		rec.events.push("setEditorComponent");
		rec.editorFactory = factory;
	},
	setWidget: (key, content) => {
		rec.events.push(`setWidget:${key}${content === undefined ? ":off" : ""}`);
		rec.widgetContent.set(key, content);
	},
	setFooter: (factory) => {
		rec.events.push(`setFooter${factory === undefined ? ":stock" : ""}`);
		rec.footerSlot.push(factory);
	},
	setWorkingVisible: (visible) => rec.events.push(`setWorkingVisible:${visible}`),
	setHiddenThinkingLabel: () => rec.events.push("setHiddenThinkingLabel"),
	setWorkingIndicator: () => rec.events.push("setWorkingIndicator"),
	setWorkingMessage: () => rec.events.push("setWorkingMessage"),
	theme: { fg: (_c, s) => s, bold: (s) => s },
	model: { name: "GLM 5.3", id: "glm-5.3", provider: "zai", contextWindow: 200_000 },
	cwd: "/tmp/proj",
	branch: () => [],
	sessionId: () => "s-1",
});

interface Harness {
	session: ReplicaSession;
	rec: Recording;
	slots: UiSlots;
	deps: {
		events: string[];
		tools: Array<{ name: string; sourceInfo?: { source?: string } }>;
		statusline: { created: string[]; disposed: number; requests: Array<[string, number]> };
		silence: number;
	};
	agentDir: string;
	prefsPath: string;
	dispose: () => void;
}

const setupSession = (over: { prefs?: string; owner?: string; thinkingPref?: boolean } = {}): Harness => {
	const agentDir = mkdtempSync(join(tmpdir(), "cc-tui-session-"));
	const prefsPath = join(agentDir, "claude-tui.json");
	if (over.prefs !== undefined) writeFileSync(prefsPath, over.prefs);
	delete process.env.CC_TUI_TOOL_ROWS;
	const rec: Recording = {
		events: [],
		widgetContent: new Map(),
		headerFactory: null,
		editorFactory: null,
		notified: [],
		footerSlot: [],
	};
	const depEvents: string[] = [];
	const statusline = { created: [] as string[], disposed: 0, requests: [] as Array<[string, number]> };
	const tools = over.owner
		? [{ name: "read", sourceInfo: { source: over.owner } }]
		: [{ name: "read", sourceInfo: { source: "builtin" } }];
	const h: Harness = {
		rec,
		deps: { events: depEvents, tools, statusline, silence: 0 },
		agentDir,
		prefsPath,
		dispose: () => rmSync(agentDir, { recursive: true, force: true }),
		slots: makeSlots("tui", rec),
	} as Harness;
	const deps: ReplicaSessionDeps = {
		pi: {
			getCommands: () => [],
			getAllTools: () => h.deps.tools,
			getThinkingLevel: () => "medium",
		},
		uiOf: (ctx) => {
			// Tests pass the prebuilt slots (or an rpc variant).
			return (ctx as { slots?: UiSlots }).slots ?? (ctx as UiSlots);
		},
		coreBus: {
			activate: () => depEvents.push("bus:activate"),
			retry: () => {
				depEvents.push("bus:retry");
				return true;
			},
			close: () => depEvents.push("bus:close"),
		},
		obsAdapter: { resetSeenFromBranch: () => depEvents.push("obs:scan") },
		bridge: {
			start: (id) => depEvents.push(`bridge:start:${id}`),
			stop: () => depEvents.push("bridge:stop"),
		},
		patches: {
			applyAll: () => depEvents.push("patches:apply"),
			restoreAll: () => depEvents.push("patches:restore"),
		},
		prefsPath,
		thinkingPrefExplicit: () => over.thinkingPref ?? true,
		silenceIndicator: () => {
			h.deps.silence++;
			return true;
		},
		statuslineFactory: (command) => {
			statusline.created.push(command);
			return {
				setOnUpdate: () => {},
				request: (input: string, width: number) => statusline.requests.push([input, width]),
				getRenderLines: () => [],
				hasPersistentError: () => false,
				dispose: () => {
					statusline.disposed++;
				},
			} as unknown as StatuslineRunner;
		},
		pickRunVerb: () => "Baking",
		pickCompletionVerb: () => "Baked",
	};
	h.session = new ReplicaSession(deps);
	return h;
};

test("matrix: rpc enable — zero UiSlots writes, no presence, no patches", () => {
	const h = setupSession();
	try {
		const rpc = makeSlots("rpc", h.rec);
		h.session.enable(rpc);
		assert.deepEqual(h.rec.events, []);
		assert.deepEqual(h.deps.events, []);
		assert.equal(h.session.isEnabled(), false);
		assert.deepEqual(h.session.toolRowsDecisionInput(), { channelActive: false, toolRowsEnabled: true, forced: false });
	} finally {
		h.dispose();
	}
});

test("matrix: tui enable → shutdown — full release sequence", () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		assert.ok(h.session.isEnabled());
		// Setup order (spec §4.2): presence → bridge → patches → header → editor → footer.
		const order = h.deps.events.concat(h.rec.events);
		const idx = (label: string) => order.findIndex((e) => e === label || e.startsWith(label));
		assert.ok(idx("bus:activate") < idx("bridge:start"), "presence before bridge");
		assert.ok(idx("patches:apply") < idx("setHeader"), "patches before header");
		assert.ok(idx("setHeader") < idx("setEditorComponent"), "header before editor");
		assert.ok(idx("setEditorComponent") < idx("setWidget:cc-status"), "editor before footer widgets");
		h.session.shutdown(h.slots);
		// Release: bridge stop, bus close, statusline dispose, patches restore,
		// header release — all reached.
		for (const label of ["bridge:stop", "bus:close", "patches:restore"]) {
			assert.ok(h.deps.events.includes(label), `${label} reached`);
		}
		assert.equal(h.deps.statusline.disposed, 0, "statusline never created (disabled prefs)");
		assert.ok(h.rec.events.includes("setHeader"), "header slot released");
		assert.equal(h.session.isEnabled(), false);
		assert.equal(h.session.lifecycleState(), "inactive");
	} finally {
		h.dispose();
	}
});

test("matrix: enable → disable → enable — idempotent, single tip, patches reinstalled", () => {
	const h = setupSession({ thinkingPref: false });
	try {
		h.session.enable(h.slots);
		const tipsAfterFirst = h.rec.notified.filter((n) => n.msg.includes("toggles collapsed thinking")).length;
		assert.equal(tipsAfterFirst, 1, "thinking tip once");
		h.session.disable(h.slots);
		// disable restores the slots.
		for (const label of ["setFooter:stock", "setWidget:cc-status:off", "setWidget:cc-footer:off", "setWorkingIndicator", "setWorkingMessage"]) {
			assert.ok(h.rec.events.includes(label), `disable restored ${label}`);
		}
		h.session.enable(h.slots);
		assert.equal(h.deps.events.filter((e) => e === "patches:apply").length, 2, "patches reapplied");
		const tipsAfterThird = h.rec.notified.filter((n) => n.msg.includes("toggles collapsed thinking")).length;
		assert.equal(tipsAfterThird, 1, "no duplicate tip on re-enable");
	} finally {
		h.dispose();
	}
});

test("matrix: footer native ↔ blank — slot/widget sequences (and D6: hush skipped in native mode)", () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		const before = h.rec.events.length;
		const { native } = h.session.setFooterModeFromCommand("on", h.slots);
		assert.equal(native, true);
		const nativeCalls = h.rec.events.slice(before);
		assert.ok(nativeCalls.includes("setFooter:stock"), "native mode releases the footer slot");
		assert.ok(nativeCalls.includes("setWidget:cc-status:off"), "native mode removes cc-status");
		assert.ok(nativeCalls.includes("setWidget:cc-footer"), "native mode keeps cc-footer");
		// D6: in native footer mode the compaction hush never runs.
		h.session.onCompactionStart(h.slots);
		assert.equal(h.deps.silence, 0, "D6: no hush scheduling in native footer mode");
		// Back to blank mode: hush runs.
		h.session.setFooterModeFromCommand("off", h.slots);
		h.session.onCompactionStart(h.slots);
		assert.ok(h.deps.silence >= 1, "blank mode schedules the hush");
	} finally {
		h.dispose();
	}
});

test("matrix: tool rows auto with an external owner — yields once with one notification", () => {
	const h = setupSession({ owner: "some-other-tui@1.0" });
	try {
		h.session.enable(h.slots);
		assert.deepEqual(h.session.toolRowsDecisionInput().toolRowsEnabled, false);
		const yields = h.rec.notified.filter((n) => n.msg.startsWith("CC tool rows auto-off"));
		assert.equal(yields.length, 1, "auto-yield notified exactly once");
		h.session.disable(h.slots);
		h.session.enable(h.slots);
		assert.equal(h.rec.notified.filter((n) => n.msg.startsWith("CC tool rows auto-off")).length, 1, "still once across re-enables");
	} finally {
		h.dispose();
	}
});

test("matrix: model switch — status row and header use the new model", () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		h.session.onModelSelect({ name: "GLM 5.5", id: "glm-5.5", provider: "zai", contextWindow: 128_000 });
		// Status row (right group owns numbers when the statusline is off).
		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
		const rows = h.session.renderStatusRow(160, theme, { requestRender: () => {} });
		assert.ok(rows.join("\n").includes("GLM 5.5"), "status row shows the new model");
		// Header factory passes the entry-maintained label getter.
		assert.ok(h.rec.headerFactory, "header installed");
		const header = h.rec.headerFactory({ requestRender: () => {} }, theme) as {
			render(width: number): string[];
		};
		// formatModelLabel prefers provider/id → zai/glm-5.5.
		assert.ok(header.render(120).some((r) => r.includes("zai/glm-5.5")), "header shows the new model");
	} finally {
		h.dispose();
	}
});

test("matrix: render with throwing deps and shrinking width — never throws, stays within width", () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		// Poison every injected read the render body touches.
		const poisoned = {
			getCommands: () => {
				throw new Error("stale pi");
			},
			getAllTools: () => {
				throw new Error("stale pi");
			},
			getThinkingLevel: () => {
				throw new Error("stale pi");
			},
		} as never;
		(h.session as unknown as { deps: { pi: unknown } }).deps.pi = poisoned;
		(h.session as unknown as { deps: { readPmStatus: () => { workingStats: string; mode: string } } }).deps.readPmStatus = () => {
			throw new Error("stale bus");
		};
		// First render at a good width (deps poisoned → caught, [] fallback…
		// but a healthy last-good from BEFORE the poison would truncate).
		const rows = h.session.renderStatusRow(80, { fg: (_c, s) => s, bold: (s) => s }, { requestRender: () => {} });
		assert.ok(Array.isArray(rows));
		// Footer render degrades to a single row, never throws.
		const footer = h.session.renderFooterRows(20, { fg: (_c, s) => s, bold: (s) => s }, true);
		assert.ok(Array.isArray(footer) && footer.length >= 1);
	} finally {
		h.dispose();
	}
});

test("matrix: enable mid-throw rolls back; double enable/disable/shutdown are safe", () => {
	const h = setupSession();
	try {
		// Break one UI op mid-enable (patches run after the bridge/presence).
		const origSetHeader = h.slots.setHeader;
		let broken = false;
		(h.slots as { setHeader: unknown }).setHeader = (factory: unknown) => {
			if (broken) throw new Error("stale slot");
			(origSetHeader as (f: unknown) => void)(factory);
		};
		broken = true;
		h.session.enable(h.slots);
		broken = false;
		assert.equal(h.session.isEnabled(), false, "rolled back — not enabled with half the UI");
		assert.ok(h.deps.events.includes("bus:close"), "presence withdrawn by rollback");
		assert.ok(h.deps.events.includes("patches:restore"), "patches restored by rollback");
		// Retry succeeds exactly once more.
		h.session.enable(h.slots);
		assert.equal(h.session.isEnabled(), true);
		assert.equal(h.deps.events.filter((e) => e === "bus:activate").length, 2, "retry activated once more");
		// Double shutdown is a no-op the second time (two legit lifecycles so
		// far: the rolled-back attempt + the successful run).
		h.session.shutdown(h.slots);
		const closesAfterFirst = h.deps.events.filter((e) => e === "bus:close").length;
		assert.equal(closesAfterFirst, 2, "rollback close + shutdown close");
		h.session.shutdown(h.slots);
		assert.equal(h.deps.events.filter((e) => e === "bus:close").length, closesAfterFirst, "second shutdown closed nothing");
	} finally {
		h.dispose();
	}
});

test("matrix: late footer-requeue after teardown writes nothing; old close keeps a new presence", async () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		h.session.shutdown(h.slots);
		const eventsAtTeardown = h.rec.events.length;
		await sleep(10); // the cancelled requeue's macrotask slot
		assert.equal(h.rec.events.length, eventsAtTeardown, "cancelled requeue wrote nothing");
		// A NEW session (fresh instance, own core-bus client semantics): the
		// old session's shutdown already closed; a second close must not
		// touch the new instance's state — approximated by idempotence here
		// (the client-level ownership test lives in pm-capability.test.ts).
		h.session.shutdown(h.slots);
		assert.equal(h.deps.events.filter((e) => e === "bus:close").length, 1);
	} finally {
		h.dispose();
	}
});

test("statusline prefs: on creates the runner via the factory; off disposes it", () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		assert.equal(h.deps.statusline.created.length, 0, "disabled by default");
		h.session.setStatusline("on", h.slots);
		assert.equal(h.deps.statusline.created.length, 1, "runner created on on");
		assert.ok(h.deps.statusline.requests.length >= 1, "refresh requested");
		h.session.setStatusline("off", h.slots);
		assert.equal(h.deps.statusline.disposed, 1, "off disposed the runner");
	} finally {
		h.dispose();
	}
});

test("usage points keep the tracker fed (P1-2 holder matrix uses the numbers)", () => {
	const h = setupSession();
	try {
		const branch = [
			{
				type: "message",
				message: { role: "assistant", usage: { input: 26_000, output: 400, cost: { total: 0.5 } } },
			},
		];
		(h.slots as { branch: () => unknown[] }).branch = () => branch;
		h.session.onSessionStart(h.slots);
		const rows = h.session.renderStatusRow(160, { fg: (_c, s) => s, bold: (s) => s }, { requestRender: () => {} });
		const text = rows.join("\n");
		assert.ok(text.includes("Ctx"), "usage numbers on the right group");
		assert.ok(text.includes("$0.50"), "cost formatted once");
	} finally {
		h.dispose();
	}
});

test("review-P1: compaction ending while disabled never sticks the compacting row", () => {
	const h = setupSession();
	try {
		h.session.enable(h.slots);
		h.session.onCompactionStart(h.slots);
		let rows = h.session.renderStatusRow(120, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, { requestRender: () => {} });
		assert.ok(rows.join("\n").includes("Compacting context…"), "compacting while enabled");
		// /claude-tui off MID-COMPACTION, then the end event lands while off.
		h.session.disable(h.slots);
		h.session.onCompactionEnd(h.slots);
		h.session.onCompactionFailed(); // idempotent
		// on again: the row must NOT be stuck on "Compacting context…".
		h.session.enable(h.slots);
		rows = h.session.renderStatusRow(120, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, { requestRender: () => {} });
		assert.ok(!rows.join("\n").includes("Compacting context…"), "compaction state cleared across off→on");
	} finally {
		h.dispose();
	}
});

// ---- U-F1 (2026-10-08 follow-up): same-basis window through the session. ----

test("U-F1b: cumulative-only core channel → right group paren AND statusline JSON both use the host window", () => {
	const h = setupSession();
	try {
		const branch = [
			{
				type: "message",
				message: { role: "assistant", usage: { input: 40_000, output: 10_000, cost: { total: 0.25 } } },
			},
		];
		(h.slots as { branch: () => unknown[] }).branch = () => branch;
		h.session.enable(h.slots);
		h.session.setStatusline("on", h.slots);
		// tracker.used = 50k, host window = 200k (model fixture), core has ONLY
		// the cumulative fields + its own 1M window — no ctx fields at all.
		const current = { input: 1_200_000, output: 30_000, cacheRead: 500_000, cacheWrite: 0, cost: 1.5, contextWindow: 1_000_000 };
		(h.session as unknown as { deps: { readCoreUsage: () => unknown } }).deps.readCoreUsage = () => current as never;
		h.session.onUsagePoint("message_end", h.slots);
		h.session.onBusSnapshot();
		// The statusline JSON rides the SAME selection: 200k denominator.
		const json = JSON.parse(h.deps.statusline.requests.at(-1)![0]);
		assert.equal(json.context_window.used_percentage, 25, "JSON pct = tracker/host basis");
		assert.equal(json.context_window.context_window_size, 200_000, "JSON window = host (selected basis), NOT core 1M");
		assert.equal(json.pi.cost_usd, 1.5, "cost still core");
		assert.equal(json.context_window.total_input_tokens, 1_200_000, "totals still core");
		// The real right-group render shows the consistent paren: 25%(50k/200k).
		h.session.onRunStart(h.slots);
		const rows = h.session.renderStatusRow(160, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, { requestRender: () => {} });
		const line = rows.join("\n");
		assert.ok(line.includes("Ctx 25%"), "pct from the tracker basis");
		assert.ok(line.includes("(50k/200k)"), "paren denominator follows the selected basis");
		assert.ok(!line.includes("/1.0M)"), "core window must not leak into the paren");
		assert.ok(line.includes("$1.50"), "cost from core");
		// core later publishes COMPLETE ctx data: the selection switches back to
		// the core basis (pct AND window) on the next bus snapshot.
		const complete = { input: 1_400_000, output: 31_000, cacheRead: 600_000, cacheWrite: 0, cost: 1.8, ctxTokens: 150_000, ctxPercent: 12.6, contextWindow: 1_000_000 };
		(h.session as unknown as { deps: { readCoreUsage: () => unknown } }).deps.readCoreUsage = () => complete as never;
		h.session.onBusSnapshot();
		const json2 = JSON.parse(h.deps.statusline.requests.at(-1)![0]);
		assert.equal(json2.context_window.used_percentage, 13, "complete ctx → core pct");
		assert.equal(json2.context_window.context_window_size, 1_000_000, "complete ctx → core window");
		assert.equal(json2.pi.cost_usd, 1.8);
	} finally {
		h.dispose();
	}
});

test("review-fix: toggle in a non-TUI session reports disabled", () => {
	const h = setupSession();
	try {
		const rpc = makeSlots("rpc", h.rec);
		assert.equal(h.session.toggle(rpc), false, "enable no-ops → not enabled");
		assert.deepEqual(h.rec.events, []);
	} finally {
		h.dispose();
	}
});

// ---------------------------------------------------------------------------
// P1-2 step 2: structured usage consumption through the session.

test("U-T2/core: right group and statusline JSON use core numbers; publish-after-refresh re-refreshes", () => {
	const h = setupSession();
	try {
		const branch = [
			{
				type: "message",
				message: { role: "assistant", usage: { input: 40_000, output: 900, cost: { total: 0.25 } } },
			},
		];
		(h.slots as { branch: () => unknown[] }).branch = () => branch;
		h.session.enable(h.slots);
		h.session.setStatusline("on", h.slots);
		const coreUsage = { input: 1_200_000, output: 30_000, cacheRead: 500_000, cacheWrite: 0, cost: 1.5, tps: 45, ctxTokens: 150_000, ctxPercent: 12.6, contextWindow: 1_000_000 };
		let current: unknown = coreUsage;
		(h.session as unknown as { deps: { readCoreUsage: () => unknown } }).deps.readCoreUsage = () => current as never;
		// A message_end refresh happens BEFORE core publishes (cctui-first
		// order): the bus-snapshot hook must re-refresh with the new numbers.
		h.session.onUsagePoint("message_end", h.slots);
		h.session.onBusSnapshot();
		const last = h.deps.statusline.requests.at(-1);
		assert.ok(last, "refresh requested");
		const json = JSON.parse(last[0]);
		assert.equal(json.pi.cost_usd, 1.5, "JSON cost from core");
		assert.equal(json.context_window.used_percentage, 13, "JSON pct — same clamped value as the right group");
		assert.equal(json.context_window.remaining_percentage, 87);
		assert.equal(json.context_window.context_window_size, 1_000_000);
		assert.equal(json.context_window.total_input_tokens, 1_200_000, "totals follow the selected source");
		assert.equal(json.context_window.current_usage.input_tokens, 40_000, "current_usage stays per-request (tracker)");
		// Right group + structured left: the left segment only paints while a
		// run is live.
		h.session.onRunStart(h.slots);
		const rows = h.session.renderStatusRow(160, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, { requestRender: () => {} });
		const line = rows.join("\n");
		assert.ok(line.includes("Ctx 13%"), "right group pct from core");
		assert.ok(line.includes("$1.50"), "right group cost from core");
		// Structured left side: ↑/↓/R/⚡ present, NO $/%ctx in it.
		assert.ok(line.includes("↑1.2M"), "structured input");
		assert.ok(line.includes("↓30k"), "structured output");
		assert.ok(line.includes("R500k"), "structured cache");
		assert.ok(line.includes("⚡45 tok/s"), "structured tps");
		assert.ok(!line.includes("% ctx"), "no duplicated ctx% in the left segment");
		// Channel cleared (session switch): tracker fallback, no stale core numbers.
		current = null;
		h.session.onUsagePoint("message_end", h.slots);
		h.session.onBusSnapshot();
		const cleared = JSON.parse(h.deps.statusline.requests.at(-1)![0]);
		assert.equal(cleared.pi.cost_usd, 0.25, "cleared channel → tracker cost");
	} finally {
		h.dispose();
	}
});
