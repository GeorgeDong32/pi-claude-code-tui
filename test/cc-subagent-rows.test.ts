/**
 * CC subagent presentation drawing tests (spec P2).
 *
 * Pins the fleet roster drawing byte-for-byte across row kinds, selection
 * states, and widths (including the 20-column degradation), the layout facts
 * the upstream coverage decision consumes, and the call-row headline shapes
 * for current and historical tool arguments. Pure: no IO, no pi runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
	compactTokenCount,
	drawCcFleetFrame,
	formatFleetElapsed,
	subagentIdentityColor,
} from "../extensions/lib/cc-subagent-rows.ts";
import {
	SUBAGENT_PRESENTATION_PROTOCOL_VERSION,
	SUBAGENT_PRESENTATION_READY_EVENT,
	SUBAGENT_PRESENTATION_REGISTER_EVENT,
	probeSubagentPresentation,
	registerSubagentPresentation,
	type SubagentPresentationEventBus,
	type SubagentPresentationFleetFrame,
	type SubagentPresentationFleetRow,
	type SubagentPresentationTheme,
} from "../extensions/lib/subagent-presentation.ts";

const NOW = 1_000_000_000_000;

const identity: SubagentPresentationTheme = { fg: (_name, text) => text };
const tone: SubagentPresentationTheme = { fg: (name, text) => `⟦${name}⟧${text}⟦/fg⟧` };

function frame(rows: SubagentPresentationFleetRow[], overrides: Partial<SubagentPresentationFleetFrame> = {}): SubagentPresentationFleetFrame {
	return {
		protocol: SUBAGENT_PRESENTATION_PROTOCOL_VERSION,
		surface: "fleet",
		revision: "r1",
		session: "session-1",
		runtimeGeneration: 0,
		width: 80,
		theme: identity,
		now: NOW,
		rows,
		selection: { active: false, selectedKey: null },
		budget: { visibleRows: rows.length, hiddenAbove: 0, hiddenBelow: 0, maxRows: 6 },
		...overrides,
	};
}

test("fleet roster: main row and agent rows with the compact token·time column", () => {
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "agent:writer", agentIdentity: "writer", state: "running", startedAt: NOW - 25_000 },
		{ rowKind: "agent", rowKey: "agent:reviewer", agentIdentity: "reviewer", state: "running", startedAt: NOW - 16_000, usage: { tokens: 8_100 } },
	]));
	assert.deepEqual(rendered.lines, [
		"  ● main",
		`  ○ writer                                                                 0·25s`,
		`  ○ reviewer                                                            8.1k·16s`,
	]);
	assert.deepEqual(rendered.layout.map((entry) => entry.rowKey), ["main", "agent:writer", "agent:reviewer"]);
	assert.ok(rendered.layout.every((entry) => !entry.truncated));
});

test("fleet roster: selection arrow replaces the glyph in place without shifting columns", () => {
	const rows: SubagentPresentationFleetRow[] = [
		{ rowKind: "main", rowKey: "main", selected: true },
		{ rowKind: "agent", rowKey: "agent:writer", agentIdentity: "writer", state: "running", startedAt: NOW - 25_000 },
	];
	const rendered = drawCcFleetFrame(frame(rows, { selection: { active: true, selectedKey: "main" } }));
	assert.equal(rendered.lines[0], "> ● main");
	assert.equal(rendered.lines[1], "  ○ writer".padEnd(80 - "0·25s".length - 1) + " " + "0·25s");

	const selectedTree = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "agent:reviewer", agentIdentity: "reviewer", state: "running", startedAt: NOW, branch: "├─", selected: true, usage: { tokens: 3_000 } },
	], { selection: { active: true, selectedKey: "agent:reviewer" } }));
	assert.equal(selectedTree.lines[1], "    ├─ > reviewer".padEnd(80 - "3.0k·0s".length - 1) + " " + "3.0k·0s");
	const unselectedTree = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "agent:reviewer", agentIdentity: "reviewer", state: "running", startedAt: NOW, branch: "├─", usage: { tokens: 3_000 } },
	], { selection: { active: true, selectedKey: "main" } }));
	assert.equal(unselectedTree.lines[1], selectedTree.lines[1].replace("> ", "○ "), "selection swaps the glyph in place; columns never shift");
});

test("fleet roster: workflow wrapper, lanes, phases, and completion nesting", () => {
	const usage = { tokens: 119_200, window: 118_900 };
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "async:wf", agentIdentity: "workflow", state: "running", startedAt: NOW - 60_000, workflowWrapperUsageOnChildren: true },
		{ rowKind: "agent", rowKey: "async:child:0", agentIdentity: "reviewer", label: "review", state: "running", startedAt: NOW - 12_000, branch: "├─", parentKey: "async:wf", usage },
		{ rowKind: "workflow-phase", rowKey: "async:wf:phase:tasks", ownerKey: "async:wf", branch: "├─", label: "Tasks", text: "Tasks · 1 done · running · 1 queued", state: "running" },
		{ rowKind: "workflow-lane", rowKey: "async:wf:wf:1", ownerKey: "async:wf", branch: "├─", name: "collect", state: "complete", startedAt: NOW - 50_000, endedAt: NOW - 42_000, durationMs: 8_000, usage: { tokens: 2_400, window: 2_200 } },
		{ rowKind: "workflow-lane", rowKey: "async:wf:wf:2", ownerKey: "async:wf", branch: "└─", name: "verify", state: "pending" },
	]));
	assert.equal(rendered.lines[1].trimEnd().endsWith("usage on child rows"), true, rendered.lines[1]);
	assert.equal(rendered.lines[2], "    ├─ ○ reviewer  review".padEnd(80 - "119.2k·12s".length - 1) + " " + "119.2k·12s");
	assert.equal(rendered.lines[3], "    ├─ ● Tasks · 1 done · running · 1 queued");
	assert.equal(rendered.lines[4], "    ├─ ✓ collect · complete · 8s · ↓ 2.2k window · 2.4k spent");
	assert.equal(rendered.lines[5], "    └─ ◦ verify · pending");
	const laneEntry = rendered.layout.find((entry) => entry.rowKey === "async:wf:wf:1");
	assert.ok(laneEntry && !laneEntry.truncated);
	const overflowLane = drawCcFleetFrame(frame([
		{ rowKind: "workflow-lane", rowKey: "o", ownerKey: "wf", branch: "└─", name: "rest", state: "complete", overflow: 4 },
	]));
	assert.equal(overflowLane.lines[0], "    └─ +4 hidden workflow steps");
});

test("fleet roster: nested rows carry identity colors, elapsed, and token spend", () => {
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "agent:owner", agentIdentity: "owner", state: "running", startedAt: NOW - 30_000 },
		{ rowKind: "nested", rowKey: "agent:owner:nested:1", ownerKey: "agent:owner", branch: "├─", name: "scout", state: "complete", startedAt: NOW - 28_000, endedAt: NOW - 20_000, durationMs: 8_000, depth: 1 },
		{ rowKind: "nested", rowKey: "agent:owner:nested:2", ownerKey: "agent:owner", branch: "└─", name: "tester", state: "running", startedAt: NOW - 12_000, depth: 1, usage: { tokens: 3_000 } },
	]));
	assert.match(rendered.lines[2], /        ├─ ✓ scout · complete · 8s/);
	assert.match(rendered.lines[3], /        └─ ● tester · running · 12s · 3\.0k tok/);
});

test("fleet roster: overflow rows are bidirectional and dim", () => {
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "overflow", rowKey: "overflow:above", direction: "above", hidden: 2 },
		{ rowKind: "agent", rowKey: "agent:a", agentIdentity: "agent-a", state: "running", startedAt: NOW },
		{ rowKind: "overflow", rowKey: "overflow:below", direction: "below", hidden: 3 },
	]));
	assert.equal(rendered.lines[1].endsWith("↑ 2 more"), true);
	assert.equal(rendered.lines[3].endsWith("↓ 3 more"), true);
});

test("fleet roster: 20-column degradation truncates without throwing and reports truncation", () => {
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "agent:reviewer", agentIdentity: "reviewer", state: "running", startedAt: NOW - 16_000, usage: { tokens: 8_100 } },
	], { width: 20 }));
	assert.equal(visibleLen(rendered.lines[0]), rendered.lines[0].length <= 20 ? rendered.lines[0].length : 20);
	for (const line of rendered.lines) assert.ok(line.length > 0);
	const agentEntry = rendered.layout.find((entry) => entry.rowKey === "agent:reviewer");
	assert.ok(agentEntry?.truncated, "narrow width must mark the agent row truncated");
});

test("fleet roster: project pane section renders a blank separator, header, and pane rows", () => {
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "section-header", rowKey: "section:project-panes", text: "project panes" },
		{ rowKind: "agent", rowKey: "pane:alpha", agentIdentity: "alpha", state: "running", startedAt: NOW - 5_000, projectPane: { summary: "3 agents", refreshedAt: NOW - 1_000 } },
	]));
	assert.deepEqual(rendered.lines.slice(1), ["", "  project panes", "  ○ alpha".padEnd(80 - "3 agents · 1s ago".length - 1) + " " + "3 agents · 1s ago"]);
	const header = rendered.layout.find((entry) => entry.rowKey === "section:project-panes");
	assert.equal(header?.fromLine, 1);
	assert.equal(header?.toLine, 2);
});

test("fleet roster: tone theme routes semantic colors", () => {
	const rendered = drawCcFleetFrame(frame([
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "workflow-phase", rowKey: "p", ownerKey: "o", branch: "├─", label: "Tasks", text: "Tasks · running", state: "running" },
		{ rowKind: "workflow-lane", rowKey: "l", ownerKey: "o", branch: "└─", name: "verify", state: "pending" },
	], { theme: tone }));
	assert.equal(rendered.lines[1], "    ├─ ⟦accent⟧●⟦/fg⟧ ⟦muted⟧Tasks · running⟦/fg⟧");
	assert.equal(rendered.lines[2], "    └─ ⟦muted⟧◦⟦/fg⟧ ⟦muted⟧verify⟦/fg⟧ · ⟦muted⟧pending⟦/fg⟧");
});

test("layout facts cover every frame row exactly once, in order", () => {
	const rows: SubagentPresentationFleetRow[] = [
		{ rowKind: "main", rowKey: "main" },
		{ rowKind: "agent", rowKey: "a", agentIdentity: "a", state: "running", startedAt: NOW },
		{ rowKind: "nested", rowKey: "n", ownerKey: "a", branch: "└─", name: "n", state: "running", depth: 1 },
	];
	const { lines, layout } = drawCcFleetFrame(frame(rows));
	assert.equal(layout.length, rows.length);
	for (const [index, entry] of layout.entries()) {
		assert.equal(entry.fromLine, index);
		assert.equal(entry.toLine, index);
		assert.ok(entry.fromLine < lines.length);
	}
});

test("helpers: compact tokens, elapsed, identity colors are stable", () => {
	assert.equal(compactTokenCount(0), "0");
	assert.equal(compactTokenCount(8_100), "8.1k");
	assert.equal(compactTokenCount(1_192_000), "1.2M");
	assert.equal(formatFleetElapsed(-100), "0s");
	assert.equal(formatFleetElapsed(16_000), "16s");
	assert.equal(subagentIdentityColor("reviewer"), subagentIdentityColor("reviewer"));
	assert.notEqual(subagentIdentityColor("reviewer"), subagentIdentityColor("scout"));
});

// ---- Protocol mirror ----

class FakeBus implements SubagentPresentationEventBus {
	readonly emitted: Array<{ channel: string; data: unknown }> = [];
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(channel) ?? [];
		list.push(handler);
		this.handlers.set(channel, list);
		return () => {
			const current = this.handlers.get(channel) ?? [];
			this.handlers.set(channel, current.filter((candidate) => candidate !== handler));
		};
	}

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
}

test("protocol mirror: registration sends the versioned envelope and settles on the reply channel", async () => {
	const bus = new FakeBus();
	const attempt = registerSubagentPresentation({ events: bus, identity: "cc-tui", surfaces: { fleet: drawCcFleetFrame }, timeoutMs: 50 });
	await Promise.resolve();
	const envelope = bus.emitted.find(({ channel }) => channel === SUBAGENT_PRESENTATION_REGISTER_EVENT)?.data as {
		protocol: number;
		replyChannel: string;
		request: { identity: string; surfaces: Record<string, unknown> };
	};
	assert.equal(envelope.protocol, 1);
	assert.equal(envelope.request.identity, "cc-tui");
	assert.equal(typeof envelope.request.surfaces.fleet, "function");
	bus.emit(envelope.replyChannel, { status: "activated", handle: { token: "t", identity: "cc-tui", generation: 0, surfaces: ["fleet"], dispose: () => {} }, surfaces: ["fleet"] });
	const result = await attempt;
	assert.equal(result.status, "activated");
});

test("protocol mirror: registration times out as not-ready without a host", async () => {
	const bus = new FakeBus();
	const result = await registerSubagentPresentation({ events: bus, identity: "cc-tui", surfaces: { fleet: drawCcFleetFrame }, timeoutMs: 5 });
	assert.equal(result.status, "not-ready");
});

test("protocol mirror: probe resolves the ready payload and rejects foreign versions", async () => {
	const bus = new FakeBus();
	const probe = probeSubagentPresentation({ events: bus, timeoutMs: 50 });
	await Promise.resolve();
	bus.emit(SUBAGENT_PRESENTATION_READY_EVENT, {
		protocol: 1,
		surfaces: ["fleet"],
		session: "session-1",
		runtimeGeneration: 3,
		events: { ready: SUBAGENT_PRESENTATION_READY_EVENT, register: SUBAGENT_PRESENTATION_REGISTER_EVENT, withdraw: "", diagnostic: "" },
	});
	const ready = await probe;
	assert.equal(ready?.runtimeGeneration, 3);
	assert.deepEqual(ready?.surfaces, ["fleet"]);

	const foreign = probeSubagentPresentation({ events: new FakeBus(), timeoutMs: 5 });
	const bus2 = new FakeBus();
	void foreign;
	const probe2 = probeSubagentPresentation({ events: bus2, timeoutMs: 50 });
	await Promise.resolve();
	bus2.emit(SUBAGENT_PRESENTATION_READY_EVENT, { protocol: 9, surfaces: [] });
	assert.equal(await probe2, null);
});

function visibleLen(line: string): number {
	return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}
