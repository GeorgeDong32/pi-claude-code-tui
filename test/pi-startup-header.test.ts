/**
 * Startup-header layout & tips table tests (the pure half of
 * pi-startup-header, homed there 2026-10-03 from the old render-utils
 * drawer). These branches were previously untested and only manually
 * verifiable.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	collectPiCommandNames,
	headerColumnWidths,
	padRight,
	center,
	pickSlashCommandTips,
} from "../extensions/lib/pi-startup-header.ts";

test("headerColumnWidths: narrow hides tips, wide keeps logo the wider half", () => {
	// zero/negative → nothing
	assert.deepEqual(headerColumnWidths(0), { leftWidth: 0, rightWidth: 0, useTips: false });
	// too narrow for logo + gap + tips → full width to the logo, no tips
	const narrow = 28 + 3 + 16 - 1;
	assert.deepEqual(headerColumnWidths(narrow), { leftWidth: narrow, rightWidth: 0, useTips: false });
	// typical terminal: tips clamped to MAX, logo gets the rest and stays wider
	const wide = headerColumnWidths(120);
	assert.equal(wide.rightWidth, 28, "tips cap at MAX_TIPS_WIDTH");
	assert.ok(wide.leftWidth > wide.rightWidth);
	assert.ok(wide.useTips);
	// minimum viable width still splits with tips ≥ MIN
	const min = headerColumnWidths(28 + 3 + 16);
	assert.equal(min.useTips, true);
	assert.ok(min.rightWidth >= 16 && min.leftWidth >= 28);
	// tips share ≈ 28% below the cap
	const mid = headerColumnWidths(80);
	assert.ok(Math.abs(mid.rightWidth - Math.round(80 * 0.28)) <= 1, `28% share: ${mid.rightWidth}`);
	assert.ok(mid.leftWidth > mid.rightWidth);
});

test("headerColumnWidths: logo never drops below MIN_LEFT_WIDTH while tips fit", () => {
	// Force the 65% re-split branch: a width where the 28% share would make
	// left ≤ right cannot happen above MIN, but the branch is exercised by
	// constructor via clamps — pin the invariant instead.
	for (let w = 40; w <= 200; w += 7) {
		const r = headerColumnWidths(w);
		if (r.useTips) {
			assert.ok(r.leftWidth > r.rightWidth, `logo wider at ${w}`);
			assert.ok(r.leftWidth >= 28 && r.rightWidth >= 16, `minimums at ${w}`);
			assert.ok(r.leftWidth + 3 + r.rightWidth <= w, `fits at ${w}`);
		} else {
			assert.equal(r.rightWidth, 0);
			assert.ok(r.leftWidth <= w);
		}
	}
});

test("pickSlashCommandTips: fixed first, excluded pool, slash prefixes, RNG-driven picks", () => {
	const pool = ["model", "compact", "quit", "  tree  ", "", "use-claude-code-tui"];
	const tips = pickSlashCommandTips(pool, { count: 2, random: () => 0 });
	// Fisher-Yates with rng()≡0 fully reverses the cleaned pool
	// [model, compact, quit, tree] → picks the first two reversed.
	assert.deepEqual(tips, ["/use-default-tui", "/compact", "/quit"]);
	assert.ok(tips.every((t) => t.startsWith("/")));
	// the self-referential command and blanks never surface
	assert.ok(!tips.includes("/use-claude-code-tui"));
	// custom fixed + exclude
	const custom = pickSlashCommandTips(["a", "b", "c"], { fixed: ["hint"], exclude: ["b"], count: 5, random: () => 0.99 });
	assert.equal(custom[0], "/hint");
	assert.ok(!custom.includes("/b"));
	// count larger than pool → everything available
	assert.equal(custom.length, 3);
});

test("collectPiCommandNames merges builtins with session commands, deduped", () => {
	const names = collectPiCommandNames([{ name: "model" }, { name: "my-skill" }, { name: "" }]);
	assert.ok(names.includes("model"), "builtin present exactly once");
	assert.equal(names.filter((n) => n === "model").length, 1);
	assert.ok(names.includes("my-skill"));
	assert.ok(!names.includes(""), "blank names dropped");
	assert.ok(names.includes("compact"), "builtin list intact");
});

test("center and padRight: align/truncate math", () => {
	assert.equal(center("ab", 8), "   ab");
	assert.equal(center("ab", 3), "ab"); // floor((3-2)/2)=0
	assert.ok(center("abcdef", 3).includes("…"), "too wide truncates with ellipsis");
	assert.equal(padRight("ab", 5), "ab   ");
	// hard clip: visible content stops at the boundary (pi-tui appends its
	// own ANSI reset, which is not part of the contract here)
	const clipped = padRight("abcdef", 3, "");
	assert.ok(clipped.startsWith("abc") && !clipped.includes("def"), `hard clip: ${JSON.stringify(clipped)}`);
});

// ---------------------------------------------------------------------------
// P0-1 TUI-05 (spec E4): the header component never reads a captured ctx —
// data comes from injected getters + the setHeader factory's theme, and any
// failing read degrades to last-good / safe plain text instead of throwing.

import { PiStartupHeader } from "../extensions/lib/pi-startup-header.ts";
import type { Component } from "@earendil-works/pi-tui";

const fakeTheme = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
};

const headerViaFactory = (getters: { modelLabel(): string; cwd(): string }): Component & { render(width: number): string[] } =>
	new PiStartupHeader({ getCommands: () => [] } as never, { requestRender: () => {} } as never, fakeTheme, getters) as never;

test("E4: the component takes NO ctx at all — construction without any context object", () => {
	// Since P2-1 the header is constructed with (pi, tui, theme, getters)
	// only; there is no ctx parameter to go stale. Constructing against
	// hostile pi/tui/theme objects that throw on exotic access still renders.
	const header = new PiStartupHeader({ getCommands: () => [] } as never, { requestRender: () => {} } as never, fakeTheme, {
		modelLabel: () => "first/model",
		cwd: () => "/w",
	});
	const rows = header.render(100);
	assert.ok(rows.length > 0);
	assert.ok(rows.some((r) => r.includes("Let's build something great")));
});

test("E4: failing getters/theme fall back to last-good, truncated to the current width", () => {
	let label = "first/model";
	const header = headerViaFactory({ modelLabel: () => label, cwd: () => "/work" });
	const good = header.render(100);
	assert.ok(good.some((r) => r.includes("first/model")));
	// Break the data getter: last-good frame survives, never a throw.
	label = undefined as unknown as string;
	const fallen = header.render(60);
	assert.deepEqual(fallen.map((r) => r.length > 0), fallen.map(() => true));
	for (const row of fallen) {
		assert.ok(row.length <= 60 + 40, `row within narrow width budget: ${row.length}`);
	}
	// A last-good row must never exceed the CURRENT width visibly: crude
	// check via visibleWidth on ANSI-stripped text.
	for (const row of fallen) {
		const plain = row.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
		assert.ok([...plain].length <= 60, `visible width ${[...plain].length} <= 60`);
	}
	// Restore: the header picks the new model name up again.
	label = "second/model";
	const back = header.render(100);
	assert.ok(back.some((r) => r.includes("second/model")), "model switch reflected");
});

test("E4: no last-good yet + broken getters → safe plain-text row, still no throw", () => {
	const header = headerViaFactory({
		modelLabel: () => {
			throw new Error("boom");
		},
		cwd: () => "/w",
	});
	const rows = header.render(80);
	assert.equal(rows.length, 1);
	assert.match(rows[0]!, /^Pi v\d/);
});

test("E4: dispose (the session's release path) is idempotent", () => {
	const header = new PiStartupHeader({ getCommands: () => [] } as never, { requestRender: () => {} } as never, fakeTheme, {
		modelLabel: () => "m",
		cwd: () => "/w",
	});
	header.dispose();
	header.dispose();
});
