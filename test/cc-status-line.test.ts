/**
 * cc-status-line table tests: right-group assembly (pct math, omission
 * rules), the left/right join's three branches, and the footer mode chip
 * (MODE_META present/absent, unknown-mode paint fallback).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	buildStatusRightGroup,
	permissionModeLabel,
	statusRowLayout,
} from "../extensions/lib/cc-status-line.ts";

const muted = (s: string) => `[m]${s}[/m]`;
const dim = (s: string) => `[d]${s}[/d]`;
const gray = (s: string) => `[g]${s}[/g]`;
const sep = "|";

test("right group: model·effort label, Ctx pct clamped, cost omitted at zero", () => {
	assert.equal(
		buildStatusRightGroup({ model: "sonnet", effort: "high", used: 1200, contextWindow: 200_000, cost: 0.5, muted, dim, sep }),
		"[m]sonnet·high[/m]|[d]Ctx [/d][m]1%[/m][d](1k/200k)[/d]|[m]$0.50[/m]",
	);
	assert.equal(
		buildStatusRightGroup({ model: "sonnet", used: 0, contextWindow: 200_000, cost: 0, muted, dim, sep }),
		"[m]sonnet[/m]",
		"no usage and no cost → model only",
	);
	// pct clamps at 100 and rounds; used>0 + win=0 omits Ctx entirely.
	assert.ok(
		buildStatusRightGroup({ model: "m", used: 500_000, contextWindow: 200_000, cost: 0, muted, dim, sep }).includes("[m]100%[/m]"),
		"pct clamps at 100",
	);
	assert.equal(
		buildStatusRightGroup({ model: "m", used: 5, contextWindow: 0, cost: 0, muted, dim, sep }),
		"[m]m[/m]",
		"win=0 omits the Ctx segment",
	);
});

test("statusRowLayout: three branches — empty right, fits with min gap, squeeze", () => {
	// empty right → plain left truncation (ellipsis form is pi-tui's own)
	assert.deepEqual(statusRowLayout("left", "", 10), ["left"]);
	const cut = statusRowLayout("0123456789A", "", 10)[0]!;
	assert.ok(cut.startsWith("0123456") && !cut.includes("89A"), `truncated to width: ${JSON.stringify(cut)}`);
	// fits exactly (leftW + rightW + 2 === width): pad is exactly 2
	assert.deepEqual(statusRowLayout("ab", "cd", 6), ["ab  cd"]);
	assert.deepEqual(statusRowLayout("ab", "cd", 10), ["ab      cd"], "pad grows to fill");
	// cannot fit: squeeze to 2-space join, then truncate to width
	const squeezed = statusRowLayout("ab", "cdef", 7)[0]!;
	assert.ok(squeezed.startsWith("ab  ") && !squeezed.includes("ef"), `squeezed and truncated: ${JSON.stringify(squeezed)}`);
});

test("permissionModeLabel: meta shapes the label, absent meta falls back to bare mode", () => {
	const paintFor = (mode: string) => (mode === "plan" ? (s: string) => `<p>${s}</p>` : gray);
	assert.equal(
		permissionModeLabel("plan", { plan: { icon: "◐", label: "Plan" } }, paintFor, gray),
		"<p>◐ plan mode on</p>[g] (shift+tab to cycle)[/g]",
	);
	assert.equal(
		permissionModeLabel("ask", undefined, paintFor, gray),
		"[g]● ask mode on[/g][g] (shift+tab to cycle)[/g]",
		"no meta → default dot + bare key + default paint",
	);
	assert.equal(permissionModeLabel("", { ask: { icon: "?", label: "Ask" } }, paintFor, gray), "", "no mode → empty chip");
});
