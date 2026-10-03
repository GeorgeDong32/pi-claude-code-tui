/**
 * cc-markdown table tests: assistant white-paint rules (fence-aware, list
 * marker preserved, styled lines untouched) and the user grey bar (❯ head,
 * NBSP padding math, narrow-width degradation). Byte-level expectations —
 * the identity-gray injection keeps output deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { assistantWhiteText, userMessageBar } from "../extensions/lib/cc-markdown.ts";

const WHITE = "\x1b[38;2;255;255;255m";
const RESET = "\x1b[39m";
const BG = "\x1b[48;2;55;55;55m";
const BG_OFF = "\x1b[49m";
const gray = (s: string) => `<g>${s}</g>`;

test("assistant: plain prose lines get the white paint", () => {
	assert.equal(assistantWhiteText("hello world"), `${WHITE}hello world${RESET}`);
	assert.equal(assistantWhiteText("two\nlines"), `${WHITE}two${RESET}\n${WHITE}lines${RESET}`);
});

test("assistant: markdown-styled lines keep their own colors", () => {
	const md = ["# Heading", "> quote", "| a | b |"].join("\n");
	const out = assistantWhiteText(md).split("\n");
	assert.equal(out[0], "# Heading");
	assert.equal(out[1], "> quote");
	assert.equal(out[2], "| a | b |");
});

test("assistant: list items wrap only the text after the marker", () => {
	assert.equal(assistantWhiteText("- item text"), `- ${WHITE}item text${RESET}`);
	assert.equal(assistantWhiteText("  1. numbered"), `  1. ${WHITE}numbered${RESET}`);
	assert.equal(assistantWhiteText("-   spaced marker"), `-   ${WHITE}spaced marker${RESET}`);
});

test("assistant: fence lines toggle; inside the fence nothing is painted", () => {
	const md = "before\n```ts\nconst x = 1;\n```\nafter";
	const lines = assistantWhiteText(md).split("\n");
	assert.equal(lines[0], `${WHITE}before${RESET}`);
	assert.equal(lines[1], "```ts");
	assert.equal(lines[2], "const x = 1;");
	assert.equal(lines[3], "```");
	assert.equal(lines[4], `${WHITE}after${RESET}`);
});

test("assistant: blank lines and bare markers stay untouched", () => {
	assert.equal(assistantWhiteText("a\n\nb").split("\n")[1], "");
});

test("user bar: first row carries ❯, continuations align with 2 spaces, NBSP pad fills the row", () => {
	const out = userMessageBar("hi", 20, gray);
	const content = `<g>❯</g> ${WHITE}hi${RESET}`;
	const pad = "\u00A0".repeat(20 - (content.length - (WHITE + RESET).length) - 1);
	assert.equal(out, `${BG}${content}${pad}${BG_OFF}`);
	// continuation rows have no ❯ and a 2-space align
	const two = userMessageBar("a\nb", 40, gray).split("\n");
	assert.ok(two[0]!.includes("❯"));
	assert.ok(!two[1]!.includes("❯"));
	assert.ok(two[1]!.startsWith(`${BG}  `));
});

test("user bar: long lines and narrow widths degrade to zero pad, never negative", () => {
	const long = "x".repeat(60);
	assert.ok(userMessageBar(long, 30, gray).includes(BG_OFF));
	assert.equal(userMessageBar("ok", 4, gray).split("\u00A0").length - 1, 0, "width 4 leaves no room for padding");
});
