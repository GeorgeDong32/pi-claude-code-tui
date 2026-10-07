/**
 * Schema-driven generic call-arg summaries (spec 2026-10-07 P1-1 R2 / R-T3).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeArgs, summaryExcerpt, type ToolParamSchema } from "../extensions/lib/tool-summary.ts";

test("R-T3: preferred field wins when schema-declared and runtime non-empty string", () => {
	const schema: ToolParamSchema = {
		type: "object",
		properties: { objective: { type: "string" }, note: { type: "string" } },
		required: ["note"],
	};
	assert.equal(summarizeArgs({ note: "req field", objective: "ship it" }, schema), "ship it");
});

test("R-T3: falls back to the first required string param", () => {
	const schema: ToolParamSchema = {
		type: "object",
		properties: { count: { type: "integer" }, slug: { type: "string" }, other: { type: "string" } },
		required: ["count", "slug", "other"],
	};
	assert.equal(summarizeArgs({ count: 3, slug: "the-slug", other: "x" }, schema), "the-slug");
	// Required non-string params are skipped, not stringified.
	assert.equal(summarizeArgs({ count: 3, other: "" }, schema), "");
});

test("R-T3: no schema / nothing usable → \"\" (caller falls back to JSON)", () => {
	assert.equal(summarizeArgs({ a: "text" }, undefined), "");
	assert.equal(summarizeArgs({ a: "text" }, {}), "");
	assert.equal(summarizeArgs({ num: 5 }, { type: "object", properties: { num: { type: "number" } }, required: ["num"] }), "");
	// Runtime type must actually be string — a declared string field holding
	// an array is not summarized (goal_questionnaire's options shape).
	assert.equal(
		summarizeArgs({ options: ["a", "b"] }, { type: "object", properties: { options: { type: "string" } }, required: ["options"] }),
		"",
	);
});

test("R-T3: empty args summarize to empty (never a JSON dump), later refresh sees new tools", () => {
	assert.equal(summarizeArgs({}, { type: "object", properties: { q: { type: "string" } } }), "");
	assert.equal(summarizeArgs(undefined, { type: "object" }), "");
	assert.equal(summarizeArgs(null, { type: "object" }), "");
	// Array args are not objects to summarize.
	assert.equal(summarizeArgs(["x"], { type: "object", properties: { q: { type: "string" } } }), "");
});

test("R-T3: long text and newlines collapse to one line with the 60-char clamp", () => {
	assert.equal(summaryExcerpt(`a\nb\n${"c".repeat(100)}`), `a b ${"c".repeat(55)}…`);
	assert.equal(summaryExcerpt(""), "");
	assert.equal(summaryExcerpt(42), "");
	assert.equal(summaryExcerpt("  spaced   out  "), "spaced out");
});

test("R-T3: unknown schema (union/$ref/recursive) is not expanded — no crash, JSON fallback", () => {
	const exotic: ToolParamSchema = {
		type: "object",
		properties: { choice: { anyOf: [{ type: "string" }, { type: "number" }] } },
		required: ["choice"],
	};
	// anyOf is not a declared plain string type → skipped (deliberate scope).
	assert.equal(summarizeArgs({ choice: "picked" }, exotic), "");
});
