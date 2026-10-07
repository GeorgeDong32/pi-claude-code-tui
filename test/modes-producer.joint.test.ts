/**
 * J-USAGE joint fixtures (spec 2026-10-08 follow-up §3): the REAL core modes
 * PRODUCER (extensions/modes/index.ts — refreshWorkingMessage →
 * publishCapability → real bus publish) drives THIS package's REAL entry
 * factory wiring (core-bus client adapters → ReplicaSession.onBusSnapshot →
 * refreshStatusline) through a controllable host adapter. No hand-authored
 * `bus.publish({usage})` anywhere: the usage objects on the wire are
 * produced by core's own sanitizeUsageNumbers from the fake branch +
 * getContextUsage the host adapter serves.
 *
 * Differences from core-bus.joint.test.ts (C7-usage): that suite publishes a
 * hand-written payload through the real bus to prove transport/validation;
 * THIS suite proves the production event → publish → subscription →
 * display/JSON chain. Both stay.
 *
 * Loading: core sources import each other with ".js" specifiers → jiti (the
 * host's own loader); the TUI entry is imported natively (same as
 * entry-lifecycle.test.ts — the wiring under test is the entry's own event
 * routing). Skipped when the sibling core checkout is absent so plain
 * `npm test` stays green on isolated machines.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import factory from "../extensions/claude-code-tui.ts";
import { readCoreUsage } from "../extensions/lib/core-bus.ts";

// CC_TUI_JOINT_CORE_ROOT: point the suite at a FIXED core revision (e.g. a
// `git worktree` checkout) when the sibling's working tree is mid-change —
// joint evidence must not read half-rewritten producer code.
const CORE_ROOT = process.env.CC_TUI_JOINT_CORE_ROOT
	? path.join(process.env.CC_TUI_JOINT_CORE_ROOT, "extensions")
	: path.resolve("node_modules/..", "..", "pi-claude-code-core", "extensions");
const CORE_AVAILABLE = existsSync(path.join(CORE_ROOT, "modes", "index.ts"));
const skip = CORE_AVAILABLE ? false : "sibling pi-claude-code-core checkout not present";

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
	createJiti = (require(jitiPath) as { createJiti?: CreateJiti }).createJiti ?? null;
} catch {
	createJiti = null;
}

interface CoreModesModule {
	default(pi: unknown): void;
}
interface CoreConfigModule {
	getConfigPath(): string;
	setConfigPath(p: string): void;
}
interface CoreProfilesModule {
	setModelsPath(p: string): void;
}
interface CoreForwardingModule {
	setAgentDirForTests(dir: string | undefined): void;
}
interface CoreBusModule {
	resetCoreBusForTests(): void;
}

const loadCore = async (): Promise<{
	modes: CoreModesModule;
	config: CoreConfigModule;
	profiles: CoreProfilesModule;
	forwarding: CoreForwardingModule;
	bus: CoreBusModule;
}> => {
	if (!createJiti) throw new Error("jiti unavailable");
	const jiti = createJiti(pathToFileURL(path.resolve("test")).href);
	const modes = (await jiti.import(path.join(CORE_ROOT, "modes", "index.ts"))) as unknown as CoreModesModule;
	const config = (await jiti.import(path.join(CORE_ROOT, "modes", "config.ts"))) as unknown as CoreConfigModule;
	const profiles = (await jiti.import(path.join(CORE_ROOT, "modes", "profiles.ts"))) as unknown as CoreProfilesModule;
	const forwarding = (await jiti.import(path.join(CORE_ROOT, "modes", "permission-forwarding.ts"))) as unknown as CoreForwardingModule;
	const bus = (await jiti.import(path.join(CORE_ROOT, "bus.ts"))) as unknown as CoreBusModule;
	// Same jiti instance → the isolated paths below are the very module
	// instances modes/index.ts imported (one shared _configPath etc.).
	return { modes, config, profiles, forwarding, bus };
};

// ---- host adapter (fake pi + ctx surfaces BOTH extensions read) ----------

type Handler = (event: unknown, ctx: unknown) => unknown;

const makePi = () => {
	const handlers = new Map<string, Handler[]>();
	const seamEvents = new Map<string, Array<(payload: unknown) => void>>();
	const commands = new Map<string, { handler: Handler }>();
	const pi: Record<string, unknown> = {
		on: (event: string, fn: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
		},
		registerCommand: (name: string, def: { handler: Handler }) => commands.set(name, def),
		registerTool: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerToolRenderer: () => {},
		registerEntryRenderer: () => {},
		registerMarkdownTransformer: () => {},
		getAllTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => "medium",
		getFlag: () => undefined,
		appendEntry: () => {},
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
			emit: () => {},
		},
	};
	return {
		pi,
		commands,
		fire: async (event: string, ctx: unknown, payload: unknown = {}) => {
			for (const fn of handlers.get(event) ?? []) await fn(payload, ctx);
		},
	};
};

/** Fake ui: records calls AND keeps the widget factories (to drive renders). */
const makeUi = () => {
	const widgets = new Map<string, { factory: unknown; options?: unknown }>();
	const rec = {
		calls: [] as string[],
		notified: [] as Array<{ msg: string; level: string }>,
		workingMessages: [] as string[],
		footerSet: 0,
	};
	const ui = {
		notify: (msg: string, level: string) => rec.notified.push({ msg, level }),
		setHeader: () => rec.calls.push("setHeader"),
		setTitle: () => rec.calls.push("setTitle"),
		setEditorComponent: () => rec.calls.push("setEditorComponent"),
		setWidget: (key: string, content: unknown, options?: unknown) => {
			rec.calls.push(`setWidget:${key}:${content === undefined ? "off" : "on"}`);
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, { factory: content, options });
		},
		setFooter: (f: unknown) => {
			rec.calls.push(`setFooter:${f === undefined ? "stock" : "factory"}`);
			if (f !== undefined) rec.footerSet++;
		},
		setFooterComponent: (f: unknown) => {
			rec.calls.push(`setFooterComponent:${f === undefined ? "stock" : "factory"}`);
			if (f !== undefined) rec.footerSet++;
		},
		setStatus: () => rec.calls.push("setStatus"),
		setWorkingVisible: () => rec.calls.push("setWorkingVisible"),
		setHiddenThinkingLabel: () => rec.calls.push("setHiddenThinkingLabel"),
		setWorkingIndicator: () => rec.calls.push("setWorkingIndicator"),
		setWorkingMessage: (m: unknown) => rec.workingMessages.push(String(m)),
		select: async () => 0,
		theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
	};
	return { ui, widgets, rec };
};

/** The shared per-event ctx: one host context both extensions read. */
const makeCtx = (ui: ReturnType<typeof makeUi>["ui"], sm: Record<string, unknown>, getContextUsage: () => unknown, cwd: string) => ({
	mode: "tui",
	hasUI: true,
	ui,
	model: { name: "GLM 5.3", id: "glm-5.3", provider: "zai", contextWindow: 200_000 },
	cwd,
	sessionManager: sm,
	getContextUsage,
});

/** Mutable fake sessionManager — the branch both sides scan. */
const makeSessionManager = (branch: unknown[]) => ({
	getSessionId: () => "s-joint-1",
	getBranch: () => branch,
	getLeafId: () => (branch.length > 0 ? `e${branch.length - 1}` : null),
});

const assistantUsage = (input: number, output: number, cacheRead = 0, cost = 0) => ({
	type: "message",
	message: { role: "assistant", content: [], usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: cost } } },
});

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const tuiStub = { requestRender: () => {} };

interface JointHarness {
	core: ReturnType<typeof makePi>;
	tui: ReturnType<typeof makePi>;
	ui: ReturnType<typeof makeUi>;
	ctx: () => unknown;
	/** The branch both sides scan (push entries to simulate turns). */
	branch: unknown[];
	/** Serve the host's getContextUsage value (undefined = host cannot report). */
	setCtxUsage: (value: unknown) => void;
	renderStatus: (width?: number) => string[];
	renderFooter: (width?: number) => string[];
	pollStatuslineJson: (until?: (json: Record<string, never>) => boolean, deadlineMs?: number) => Promise<Record<string, never> | null>;
	dispose: () => Promise<void>;
}

const setupJoint = async (order: "core-first" | "tui-first"): Promise<JointHarness> => {
	const agentDir = mkdtempSync(join(tmpdir(), "cc-tui-jusage-"));
	const projDir = mkdtempSync(join(tmpdir(), "cc-tui-jusage-proj-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	const prevToolRows = process.env.CC_TUI_TOOL_ROWS;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.CC_TUI_TOOL_ROWS;
	// statusline ON with `cat` as the script: the REAL subprocess protocol
	// round-trips the session's JSON input verbatim (parse it back below).
	writeFileSync(path.join(agentDir, "claude-tui.json"), JSON.stringify({ statusLine: { enabled: true, command: "cat", badge: false } }));

	const g = globalThis as Record<string, unknown>;
	delete g.__piClaudeCodeCore;
	delete g.__piClaudeCodeCoreCmd;
	delete g.__piPermissionModes;
	delete g.__pmWorkingStats;
	delete g.__piCcTui;
	delete g.__ccTuiActive;

	const core = await loadCore();
	// Isolate every core path that session_start touches (config caches,
	// profile ensure-write, forwarding poller inbox).
	const prevConfigPath = core.config.getConfigPath();
	core.config.setConfigPath(path.join(agentDir, "permission-modes.json"));
	core.profiles.setModelsPath(path.join(agentDir, "model-profiles.json"));
	core.forwarding.setAgentDirForTests(agentDir);

	const branch: unknown[] = [];
	const sm = makeSessionManager(branch);
	const ctxUsageState: { value: unknown } = { value: undefined as unknown };
	const ui = makeUi();
	const ctx = () => makeCtx(ui.ui, sm, () => ctxUsageState.value, projDir);

	const tui = makePi();
	const corePi = makePi();
	if (order === "core-first") {
		core.modes.default(corePi.pi as never);
		factory(tui.pi as never);
	} else {
		factory(tui.pi as never);
		core.modes.default(corePi.pi as never);
	}

	const renderWidget = (key: string, width: number): string[] => {
		const entry = ui.widgets.get(key);
		if (!entry) return [];
		const widget = (entry.factory as (t: unknown, t2: unknown) => { render(w: number): string[] })(tuiStub, theme);
		return widget.render(width);
	};

	const dispose = async () => {
		await tui.fire("session_shutdown", ctx()).catch(() => {});
		await corePi.fire("session_shutdown", ctx()).catch(() => {});
		core.bus.resetCoreBusForTests();
		core.config.setConfigPath(prevConfigPath);
		core.profiles.setModelsPath(join(homedir(), ".pi", "agent", "model-profiles.json")); // core's default (no getter exported)
		core.forwarding.setAgentDirForTests(undefined);
		delete g.__piClaudeCodeCore;
		delete g.__piClaudeCodeCoreCmd;
		delete g.__piPermissionModes;
		delete g.__pmWorkingStats;
		delete g.__piCcTui;
		delete g.__ccTuiActive;
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		if (prevToolRows === undefined) delete process.env.CC_TUI_TOOL_ROWS;
		else process.env.CC_TUI_TOOL_ROWS = prevToolRows;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projDir, { recursive: true, force: true });
	};

	return {
		core: corePi,
		tui,
		ui,
		ctx,
		branch,
		setCtxUsage: (value: unknown) => {
			ctxUsageState.value = value;
		},
		renderStatus: (width = 160) => renderWidget("cc-status", width),
		renderFooter: (width = 2000) => renderWidget("cc-footer", width),
		// The runner debounces 250ms then spawns `cat`; poll the footer rows
		// until the script output satisfies `until` (the runner keeps the
		// LAST completed lines — a follow-up refresh first shows the stale
		// JSON, so late-publish assertions must wait for the new one).
		pollStatuslineJson: async (until?: (json: Record<string, never>) => boolean, deadlineMs = 6000) => {
			const deadline = Date.now() + deadlineMs;
			while (Date.now() < deadline) {
				const line = renderWidget("cc-footer", 2000).find((row) => row.trimStart().startsWith("{"));
				if (line) {
					try {
						const json = JSON.parse(line.trim()) as Record<string, never>;
						if (!until || until(json)) return json;
					} catch {
						/* partial line — keep polling */
					}
				}
				await sleep(100);
			}
			return null;
		},
		dispose,
	};
};

test("J1 core-first: production turn_start/message_update publish → TUI status row + statusline JSON (no hand-authored payloads)", { skip }, async () => {
	if (!createJiti || !CORE_AVAILABLE) return; // narrowed for TS
	const h = await setupJoint("core-first");
	try {
		// Session up: core first (bus + mode publish), then the TUI replica
		// (presence → attach). Prefs have the statusline on (`cat`).
		await h.core.fire("session_start", h.ctx());
		await h.tui.fire("session_start", h.ctx());
		assert.ok(h.ui.widgets.has("cc-status"), "TUI session mounted the status widget");

		// The turn: one assistant message in the branch; the HOST reports
		// context usage. Production refreshWorkingMessage derives modes.usage
		// from exactly these.
		h.branch.push({ type: "message", id: "e0", message: { role: "user", content: "hi" } });
		h.branch.push({ id: "e1", ...assistantUsage(1_200_000, 30_000, 500_000, 1.5) });
		h.setCtxUsage({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 });

		// CORE production events (turn_start refresh, message_update stream
		// refresh, before_provider_request forced usage read).
		await h.core.fire("turn_start", h.ctx());
		await h.core.fire("message_update", h.ctx());
		await h.core.fire("before_provider_request", h.ctx());

		// The published channel — produced by core, never hand-authored.
		const usage = readCoreUsage();
		assert.ok(usage, "modes.usage on the wire");
		assert.equal(usage!.input, 1_200_000, "branch-summed input (production accumulateBranchStats)");
		assert.equal(usage!.cost, 1.5);
		assert.equal(usage!.ctxTokens, 150_000, "host context usage flowed through sanitizeUsageNumbers");
		assert.equal(usage!.ctxPercent, 15);
		assert.equal(usage!.contextWindow, 1_000_000);

		// TUI display surface 1: the cc-status right group (real widget render).
		await h.tui.fire("message_end", h.ctx()); // TUI's own refresh point (post-core-publish too)
		const row = h.renderStatus().join("\n");
		assert.ok(row.includes("Ctx 15%"), "right-group pct from the core channel");
		assert.ok(row.includes("(150k/1.0M)"), "paren from the core basis");
		assert.ok(!row.includes("/200k)"), "host window must not mix into the core basis");

		// TUI display surface 2: the statusline JSON through the REAL script
		// protocol (`cat` echoes the session's JSON input back).
		const json = await h.pollStatuslineJson();
		assert.ok(json, "statusline script produced output");
		const cw = (json as never as { context_window: Record<string, number> }).context_window;
		assert.equal(cw.used_percentage, 15);
		assert.equal(cw.context_window_size, 1_000_000);
		assert.equal((json as never as { pi: { cost_usd: number } }).pi.cost_usd, 1.5);
		assert.equal(cw.total_input_tokens, 1_200_000, "totals follow the selected (core) source");
	} finally {
		await h.dispose();
	}
});

test("J2 tui-first: TUI refresh before any core publish (tracker basis), late production publish re-refreshes to core numbers", { skip }, async () => {
	if (!createJiti || !CORE_AVAILABLE) return;
	const h = await setupJoint("tui-first");
	try {
		// TUI session up FIRST: no bus yet — presence declared on an empty
		// store, retry finds nothing.
		await h.tui.fire("session_start", h.ctx());
		assert.ok(h.ui.widgets.has("cc-status"));

		// A turn completes BEFORE core ever publishes: the tracker + host
		// window are the basis (50k/200k).
		h.branch.push({ type: "message", id: "e0", message: { role: "user", content: "hi" } });
		h.branch.push({ id: "e1", ...assistantUsage(40_000, 10_000, 0, 0.25) });
		await h.tui.fire("message_end", h.ctx());
		let row = h.renderStatus().join("\n");
		assert.ok(row.includes("Ctx 25%"), "pre-publish basis is the tracker");
		assert.ok(row.includes("(50k/200k)"), "host window is the denominator");
		const early = await h.pollStatuslineJson();
		assert.ok(early, "statusline produced output pre-publish");
		assert.equal((early as never as { context_window: Record<string, number> }).context_window.used_percentage, 25);
		assert.equal((early as never as { context_window: Record<string, number> }).context_window.context_window_size, 200_000);

		// Core loads/starts LATE (tui-first order): session_start clears usage,
		// the bus appears; the TUI attach happens at the next render/retry
		// point (the widget render IS one).
		await h.core.fire("session_start", h.ctx());
		h.renderStatus(); // render-time retry point attaches to the new bus
		h.setCtxUsage({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 });
		h.branch.push({ id: "e2", ...assistantUsage(1_200_000, 30_000, 500_000, 1.5) });
		// The production publish lands AFTER the TUI's own refresh point —
		// the entry's bus-snapshot adapter must re-refresh (identity change).
		await h.core.fire("message_update", h.ctx());

		const usage = readCoreUsage();
		assert.ok(usage && usage.ctxPercent === 15, "production publish visible on the store");
		const late = await h.pollStatuslineJson((j) => (j as never as { context_window: { used_percentage: number } }).context_window.used_percentage === 15);
		assert.ok(late, "statusline produced output after the late publish");
		assert.equal((late as never as { context_window: Record<string, number> }).context_window.used_percentage, 15);
		assert.equal((late as never as { context_window: Record<string, number> }).context_window.context_window_size, 1_000_000);
		// Right-group view: with the script row holding the numbers the right
		// group collapses by design (single display) — turn the statusline
		// OFF so the right group becomes the fallback holder, then assert the
		// basis switch on the row itself.
		await h.tui.commands.get("claude-statusline")!.handler("off", h.ctx());
		row = h.renderStatus().join("\n");
		assert.ok(row.includes("Ctx 15%"), "late publish re-refreshed the right group");
		assert.ok(row.includes("(150k/1.0M)"), "basis switched to core");
	} finally {
		await h.dispose();
	}
});

test("J3 production clears/zeros/missing ctx: session_start clears, true zeros pass, absent ctx falls back as ONE group (U-F1)", { skip }, async () => {
	if (!createJiti || !CORE_AVAILABLE) return;
	const h = await setupJoint("core-first");
	try {
		await h.core.fire("session_start", h.ctx());
		await h.tui.fire("session_start", h.ctx());
		h.branch.push({ type: "message", id: "e0", message: { role: "user", content: "hi" } });
		h.branch.push({ id: "e1", ...assistantUsage(40_000, 10_000, 0, 0.25) });

		// TRUE ZERO host usage: tokens 0 / percent 0 are data — core keeps
		// them; the display shows 0% on the core basis, never "missing".
		h.setCtxUsage({ tokens: 0, contextWindow: 1_000_000, percent: 0 });
		await h.core.fire("turn_start", h.ctx());
		let usage = readCoreUsage();
		assert.equal(usage!.ctxTokens, 0, "true zero published");
		assert.equal(usage!.ctxPercent, 0);
		await h.tui.fire("message_end", h.ctx());
		let row = h.renderStatus().join("\n");
		assert.ok(row.includes("Ctx 0%"), "true zero renders");
		// Pinned display rule (P1-2 step 2): used=0 shows the pct WITHOUT the
		// (used/win) paren — the data layer still carries the core window.
		assert.ok(!row.includes("(0/"), "no paren for a zero-token basis (by design)");
		let json = await h.pollStatuslineJson();
		assert.ok(json);
		assert.equal((json as never as { context_window: Record<string, number> }).context_window.used_percentage, 0);
		assert.equal((json as never as { context_window: Record<string, number> }).context_window.context_window_size, 1_000_000, "true-zero basis keeps the core window");

		// MISSING ctx (host cannot report): sanitize omits both fields → the
		// cumulative-only channel → the WHOLE ctx group switches to
		// tracker+host (U-F1: the core window must not leak in). Production
		// re-reads host usage on before_provider_request (forceUsage) — the
		// cache hit on message_update would keep the stale host numbers.
		h.setCtxUsage({ tokens: null, contextWindow: 1_000_000, percent: null });
		await h.core.fire("before_provider_request", h.ctx());
		usage = readCoreUsage();
		assert.ok(usage && usage.ctxTokens === undefined && usage.ctxPercent === undefined, "absent ctx fields omitted (not faked 0)");
		// Script rows hold the numbers now — turn the statusline OFF so the
		// right group is the fallback holder, then assert the row basis.
		await h.tui.commands.get("claude-statusline")!.handler("off", h.ctx());
		row = h.renderStatus().join("\n");
		assert.ok(row.includes("Ctx 25%"), "tracker pct fills");
		assert.ok(row.includes("(50k/200k)"), "host window — no 1.0M leak (U-F1)");

		// NEW SESSION (production clear): core session_start publishes
		// usage:null — the channel falls back wholesale to the tracker. The
		// new assistant message changes the tracker basis (100k/0.65) so the
		// post-clear display DISCRIMINATES: a stale channel would keep the
		// old core cost (0.25) and the old pct (25%).
		h.branch.push({ id: "e2", ...assistantUsage(80_000, 20_000, 0, 0.4) });
		await h.core.fire("session_start", h.ctx());
		assert.equal(readCoreUsage(), null, "cleared channel");
		await h.tui.commands.get("claude-statusline")!.handler("on", h.ctx());
		await h.tui.fire("message_end", h.ctx());
		json = await h.pollStatuslineJson((j) => (j as never as { pi: { cost_usd: number } }).pi.cost_usd === 0.65);
		assert.ok(json);
		assert.equal((json as never as { pi: { cost_usd: number } }).pi.cost_usd, 0.65, "cleared → tracker cost (new basis)");
		assert.equal((json as never as { context_window: Record<string, number> }).context_window.used_percentage, 50, "tracker pct (new basis)");
		assert.equal((json as never as { context_window: Record<string, number> }).context_window.context_window_size, 200_000, "tracker window");

		// session_tree clears too (production reload path — same handler pair):
		// republish, then a tree switch must null the channel again.
		h.setCtxUsage({ tokens: 150_000, contextWindow: 1_000_000, percent: 15 });
		await h.core.fire("message_update", h.ctx());
		assert.ok(readCoreUsage(), "republished before the tree switch");
		await h.core.fire("session_tree", h.ctx());
		assert.equal(readCoreUsage(), null, "session_tree cleared the channel");
	} finally {
		await h.dispose();
	}
});
