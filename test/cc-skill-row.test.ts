/**
 * Skill invocation row patch tests: the native [skill] box must render as
 * one CC-style "⏺ Skill(name)" line (Claude Code SkillTool/UI.tsx shows
 * just the name), with the SKILL.md body expanding under the ⎿ gutter.
 * keyText() returns "" outside a host session, so the expand hint falls
 * back to "(ctrl+o to expand)". The patch is idempotent (guarded by a
 * prototype marker), so the fg-fallback case is exercised through a
 * mutable binding instead of a second patch call.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { initTheme, SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { patchSkillRow, type ThemeFg } from "../extensions/lib/cc-skill-row.ts";

// The Box base class reads the global theme during render; init a default.
initTheme(undefined as unknown as string);

const fg: ThemeFg = (_color: string, text: string) => text;
let currentFg: ThemeFg | null = fg;
patchSkillRow(() => currentFg);

const baseBlock = {
	name: "improve-codebase-architecture",
	location: "/home/u/.pi/agent/skills/ica/SKILL.md",
	content: "Audit the architecture.\nPropose deepening opportunities.",
	userMessage: undefined,
};
const block = baseBlock as never;

const makeComponent = () => new SkillInvocationMessageComponent(block, {} as never);

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

function renderPlain(component: { render(width: number): string[] }): string[] {
	return component.render(100).map(strip);
}

test("collapsed skill renders the single CC-style line, flush and bg-free", () => {
	const component = makeComponent();
	const lines = renderPlain(component);
	assert.ok(lines.some((l) => l.startsWith("⏺ Skill(improve-codebase-architecture)")));
	assert.ok(lines.some((l) => l.includes("(ctrl+o to expand)")));
	assert.ok(!lines.some((l) => l.includes("Audit the architecture")));
	// Box chrome removed: no padding lines above/below, no bg escape codes.
	assert.ok(lines.every((l) => l.length === 0 || !l.startsWith(" ")));
	assert.equal(lines.length, 1);
});

test("raw render carries no background escape even before stripping", () => {
	const component = makeComponent();
	const raw = component.render(100).join("\n");
	assert.ok(!raw.includes("\x1b[48;"));
	assert.ok(!raw.includes("\x1b[41m"));
});

test("expanded skill renders ONE gutter: first row carries ⎿, the rest align under it", () => {
	const component = makeComponent();
	(component as unknown as { setExpanded(e: boolean): void }).setExpanded(true);
	const lines = renderPlain(component).filter((l) => l.trim().length > 0 || l.startsWith(" "));
	assert.ok(lines.some((l) => l.includes("⏺ Skill(improve-codebase-architecture)")));
	assert.ok(!lines.some((l) => l.includes("(ctrl+o to expand)")));
	// First body row: gutter + first content line.
	const firstBody = lines.find((l) => l.includes("Audit the architecture."));
	assert.ok(firstBody?.startsWith("  ⎿  "), `first body row must carry the gutter: ${JSON.stringify(firstBody)}`);
	// Later rows (new paragraph, blank-line separators) align with 5 spaces — no repeated ⎿.
	const later = lines.find((l) => l.includes("Propose deepening opportunities."));
	assert.ok(later?.startsWith("     ") && !later.includes("⎿"), `later rows must be indent-aligned: ${JSON.stringify(later)}`);
	// Blank lines between paragraphs become indent-only rows, never bare ⎿.
	const blanks = renderPlain(component).filter((l) => l.trim().length === 0);
	assert.ok(blanks.every((l) => !l.includes("⎿")), "blank rows must not repeat the gutter glyph");
	assert.equal(lines.filter((l) => l.includes("⎿")).length, 1, "exactly one gutter row in the block");
});

test("expanded long body wraps as indent-aligned continuations, width-capped", () => {
	const longBlock = {
		...baseBlock,
		content:
			"Deep modules hide behind simple interfaces so that complexity stays where implementation can absorb it.",
	} as never;
	const component = new SkillInvocationMessageComponent(longBlock, {} as never);
	(component as unknown as { setExpanded(e: boolean): void }).setExpanded(true);
	const lines = renderPlain(component).filter((l) => l.trim().length > 0);
	assert.ok(lines.length > 1, "expected the long line to wrap");
	for (const line of lines) {
		assert.ok(line.length <= 100, `line exceeds width: ${line.length}`);
	}
	// Wrapped continuation rows carry no second gutter glyph.
	assert.equal(lines.filter((l) => l.includes("⎿")).length, 1);
});

test("collapsed skill name truncates to a single line on narrow widths", () => {
	const component = makeComponent();
	const lines = renderPlain(component);
	void component.render(30).map(strip);
	assert.equal(lines.length, 1);
});

test("fg fallback keeps the line readable when no theme is cached", () => {
	currentFg = null;
	const component = makeComponent();
	const lines = renderPlain(component);
	assert.ok(lines.some((l) => l.includes("Skill(improve-codebase-architecture)")));
	currentFg = fg;
});

test("patch is idempotent — a second call must not duplicate the row", () => {
	patchSkillRow(() => fg);
	const component = makeComponent();
	const lines = renderPlain(component);
	assert.equal(lines.filter((l) => l.startsWith("⏺ Skill(")).length, 1);
});
