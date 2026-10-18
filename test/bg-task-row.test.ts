// BG-ENTRY-03 TUI side: the bg-shell task-status pseudo tool row. core
// appends the display-only entry; this package renders it as a CC-style
// call row (state-colored dot, like every tool row) plus a ⎿ detail gutter.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bgTaskRows, type BgTaskEventData } from "../extensions/lib/bg-task-row.ts";

// ccCall paints the tool name with a hard-coded ANSI white; assert on visible text.
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

const theme = {
	fg: (color: string, text: string) => `\u001b[${color}]{${text}}`,
	bold: (text: string) => `**${text}**`,
} as never;

const base: BgTaskEventData = { id: "bg-10", command: 'sleep 6 && echo "R4-1 done"', state: "exited", exitCode: 0, runtimeMs: 8000 };

const plain = {
	fg: (_c: string, text: string) => text,
	bold: (text: string) => text,
} as never;

describe("bgTaskRows (BG-ENTRY-03 pseudo tool row)", () => {
	it("no label: the command is the call row (CC /tasks label split), gutter drops it", () => {
		const rows = bgTaskRows(plain, base, 100).map(stripAnsi);
		assert.equal(rows.length, 2);
		assert.match(rows[0]!, /^⏺ Background Task\(sleep 6 && echo "R4-1 done"\)$/);
		assert.ok(!rows[0]!.includes("bg-10"), "no id on the visible row");
		assert.match(rows[1]!, /^ {2}⎿ {2}completed in background · ran 8\.0s$/); // command not repeated
	});

	it("success dot on exit 0, error dot on failure, running dot (dim) on stop", () => {
		assert.match(bgTaskRows(theme, base, 100)[0]!, /success/);
		assert.match(bgTaskRows(theme, { ...base, exitCode: 2 }, 100)[0]!, /error/);
		const rows = bgTaskRows(theme, { ...base, state: "killed" }, 100);
		assert.match(rows[0]!, /dim/); // the stop dot paints dim
		assert.match(rows[1]!, /stopped · ran 8\.0s/);
	});

	it("with a label the id leaves the call row (CC GenericTaskStatus parity)", () => {
		const rows = bgTaskRows(plain, { ...base, description: "build the frontend" }, 100).map(stripAnsi);
		assert.match(rows[0]!, /^⏺ Background Task\(build the frontend\)$/);
		assert.ok(!rows[0]!.includes("bg-10"), "no id on the visible row");
		// gutter carries the command when the title is a label
		assert.match(rows[1]!, /completed in background · ran 8\.0s · sleep 6 && echo "R4-1 done"$/);
	});

	it("failure names the exit code; multi-line commands fold to one line", () => {
		const rows = bgTaskRows(plain, { ...base, exitCode: 3, command: "echo a\necho b" }, 100).map(stripAnsi);
		assert.match(rows[1]!, /failed in background \(exit 3\)/);
		assert.match(rows[0]!, /echo a ⏎ echo b/); // folded command is the title
	});

	it("long commands truncate to the terminal width, never wrap (label-less title)", () => {
		const rows = bgTaskRows(plain, { ...base, command: `echo ${"x".repeat(200)}` }, 60).map(stripAnsi);
		assert.equal(rows.length, 2);
		for (const row of rows) assert.ok(row.length <= 60, `row fits: ${row.length}`);
		assert.ok(rows[0]!.endsWith("…)"), `title ellipsized: ${rows[0]}`);
	});
});
