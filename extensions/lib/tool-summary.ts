/**
 * Schema-driven generic call-arg summaries (spec 2026-10-07 P1-1, R2).
 *
 * The name-based table in cc-rows.ts drifts whenever core registers a new
 * tool — unknown names fell to a whole-JSON row. This module derives a
 * one-line summary from the tool's own parameter schema (cached from
 * `pi.getAllTools()` by the entry at enable / session_start /
 * mcp_servers_change; renderers only READ the cache):
 *
 * - Preferred field names (objective, query, question, …) win when the
 *   schema declares them at top level AND the runtime value is a non-empty
 *   string.
 * - Otherwise the first REQUIRED parameter whose schema type is `string`
 *   and whose runtime value is a non-empty string.
 * - Nothing usable → "" (the caller falls back to a bounded JSON dump);
 *   union/$ref/recursive schemas are deliberately not expanded this round.
 *
 * Pure and never-throwing by construction: every input is validated before
 * use, and the caller clamps the result to the CC one-line budget.
 */

export interface ToolParamSchema {
	type?: string;
	properties?: Record<string, unknown>;
	required?: readonly unknown[];
}

/** Preference order mirrors how core tools name their headline argument. */
const PREFERRED_FIELDS = [
	"objective",
	"query",
	"question",
	"reason",
	"changeSummary",
	"path",
	"file",
	"url",
	"command",
	"topic",
	"title",
	"summary",
	"name",
] as const;

const SUMMARY_MAX_CHARS = 60;

/** Whitespace-collapsed, single-line, ellipsized excerpt of a string value. */
export const summaryExcerpt = (value: unknown, max = SUMMARY_MAX_CHARS): string => {
	if (typeof value !== "string") return "";
	const t = value.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const isDeclaredString = (prop: unknown): boolean =>
	prop != null && typeof prop === "object" && (prop as { type?: unknown }).type === "string";

/**
 * Summarize call args by schema. Returns "" when nothing usable is found —
 * distinct from a genuinely empty args object, which also summarizes to ""
 * (an empty row, never a JSON dump; see callArgsFor).
 */
export const summarizeArgs = (args: unknown, schema?: ToolParamSchema): string => {
	if (args == null || typeof args !== "object" || Array.isArray(args)) return "";
	const record = args as Record<string, unknown>;
	if (Object.keys(record).length === 0) return ""; // empty params → empty summary
	if (schema == null || typeof schema !== "object") return ""; // caller falls back to JSON

	const props = schema.properties;
	if (props != null && typeof props === "object") {
		for (const field of PREFERRED_FIELDS) {
			if (field in props) {
				const excerpt = summaryExcerpt(record[field]);
				if (excerpt !== "") return excerpt;
			}
		}
	}
	const required = Array.isArray(schema.required) ? schema.required : [];
	for (const name of required) {
		if (typeof name !== "string") continue;
		if (!isDeclaredString(props?.[name])) continue;
		const excerpt = summaryExcerpt(record[name]);
		if (excerpt !== "") return excerpt;
	}
	return "";
};
