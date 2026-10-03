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
