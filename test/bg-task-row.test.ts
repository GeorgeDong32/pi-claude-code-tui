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
	it("renders the call row + ⎿ gutter, paired with TaskOutput rows", () => {
		const rows = bgTaskRows(plain, base, 100).map(stripAnsi);
		assert.equal(rows.length, 2);
		assert.match(rows[0]!, /^⏺ Background Task\(bg-10\)$/);
		assert.match(rows[1]!, /^ {2}⎿ {2}completed in background · ran 8\.0s · sleep 6 && echo "R4-1 done"$/);
	});

	it("success dot on exit 0, error dot on failure, running dot (dim) on stop", () => {
		assert.match(bgTaskRows(theme, base, 100)[0]!, /success/);
		assert.match(bgTaskRows(theme, { ...base, exitCode: 2 }, 100)[0]!, /error/);
		const rows = bgTaskRows(theme, { ...base, state: "killed" }, 100);
		assert.match(rows[0]!, /dim/); // the stop dot paints dim
		assert.match(rows[1]!, /stopped · ran 8\.0s/);
	});

	it("failure names the exit code; multi-line commands fold to one line", () => {
		const rows = bgTaskRows(plain, { ...base, exitCode: 3, command: "echo a\necho b" }, 100).map(stripAnsi);
		assert.match(rows[1]!, /failed in background \(exit 3\)/);
		assert.match(rows[1]!, /echo a ⏎ echo b/);
	});

	it("long commands truncate to the terminal width, never wrap", () => {
		const rows = bgTaskRows(plain, { ...base, command: `echo ${"x".repeat(200)}` }, 60).map(stripAnsi);
		assert.equal(rows.length, 2);
		for (const row of rows) assert.ok(row.length <= 60, `row fits: ${row.length}`);
	});
});
