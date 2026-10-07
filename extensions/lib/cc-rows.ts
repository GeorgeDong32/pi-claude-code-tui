/**
 * Claude Code-style tool rows (plan C3 extraction).
 *
 * Pure renderers extracted verbatim from claude-code-tui.ts so they can be
 * golden-tested without the extension factory (theme is duck-typed and
 * injected). Behavior must stay byte-identical — the golden tests in
 * test/cc-rows.golden.test.ts are the equivalence net for the A6 wrap-cache
 * and future render changes.
 */

import { keyText, renderDiff } from "@earendil-works/pi-coding-agent";
import { summarizeArgs } from "./tool-summary.ts";

/** Expand keybinding with a hard fallback (plan B4): keyText yields "" for
 *  unregistered bindings (e.g. outside a host session), which rendered a
 *  bare "( to expand)" — "ctrl+o" is pi's default tools-expand binding. */
const expandKeyHint = (): string => keyText("app.tools.expand") || "ctrl+o";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const RESET = "\x1b[39m";

export const strArg = (v: unknown): string => (typeof v === "string" ? v : "");
export const collapseCommand = (cmd: string): string => {
	const first = cmd.split("\n")[0] ?? "";
	return cmd.includes("\n") ? `${first} …` : first;
};

export const textOfResult = (result: unknown): string => {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
};

export interface CCTheme {
	fg(color: string, s: string): string;
	bold(s: string): string;
}

// Concise args summaries for the seven built-in tool names, shared by the
// registerTool override path and the force-mode prototype patch so a
// third-party override of a built-in name (e.g. SoL-Pi's fused edit/write)
// gets the same `⏺ Tool(arg)` call row as the fork-owned built-ins.
/** CC call-row clamp (BashTool/UI.tsx:26-27 semantics): never let a call
 * argument line exceed one visual line — 160 chars, ellipsis, whole tail cut. */
export const CLAMP_CALL_ARGS_CHARS = 160;
export const clampCallSummary = (text: string): string =>
	text.length > CLAMP_CALL_ARGS_CHARS ? `${text.slice(0, CLAMP_CALL_ARGS_CHARS - 1)}…` : text;

export const builtinCallArgs: Record<string, (a: Record<string, unknown>) => string> = (() => {
	// ── pi-claude-code-core tools: one-line summaries instead of the JSON
	// fallback (which put whole goal drafts / recall queries on the row).
	// The GENERIC schema-driven summary (lib/tool-summary.ts, spec P1-1 R2)
	// covers every tool that exposes a recognizable top-level string param —
	// only rules the generic cannot express stay in this table:
	//   obs_recall        — id+offset needs two fields formatted together
	//   memory_consolidate — counts an ARRAY param (ops), not a string
	//   session_recall    — query + optional "since …" suffix composed
	// Everything else core registers (goal family, review, questionnaire…)
	// is summarized from its parameter schema at render time.
	const shortText = (v: unknown, max = 60): string => {
		const t = strArg(v).replace(/\s+/g, " ").trim();
		return t.length > max ? `${t.slice(0, max - 1)}…` : t;
	};
	const builtins: Record<string, (a: Record<string, unknown>) => string> = {
	read: (a) => strArg(a.path),
	bash: (a) => clampCallSummary(collapseCommand(strArg(a.command))),
	grep: (a) => {
		const p = strArg(a.pattern);
		const path = strArg(a.path);
		return path ? `${p} in ${path}` : p;
	},
	find: (a) => {
		const p = strArg(a.pattern);
		const path = strArg(a.path);
		return path ? `${p} in ${path}` : p;
	},
	ls: (a) => strArg(a.path) || ".",
	write: (a) => strArg(a.path),
	edit: (a) => strArg(a.path),
	// ── core: memory / recall — composed shapes the generic cannot build.
	session_recall: (a) => [shortText(a.query, 40), a.since ? `since ${strArg(a.since)}` : ""].filter(Boolean).join(" · "),
	memory_consolidate: (a) => {
		const ops = a.operations as unknown[] | undefined;
		return ops?.length ? `${ops.length} ops` : shortText(a.reason, 40);
	},
	// TR D2 (spec 2026-10-02-core-tool-renderers): the raw JSON id/offset pair
	// is unreadable in the CC row — collapse to `obs_4b1d7b39 · +15.5KB`
	// (id truncated to 16 chars; byte offset humanized to KB, "start" at 0).
	// Single home for this rule: both wiring paths (registered overrides and
	// the force-mode prototype patch) route through callArgsFor.
	obs_recall: (a) => {
		const id = typeof a.id === "string" && a.id ? (a.id.length <= 16 ? a.id : a.id.slice(0, 16)) : "obs_?";
		const off = typeof a.offset === "number" && a.offset > 0 ? `+${(a.offset / 1024).toFixed(1)}KB` : "start";
		return `${id} · ${off}`;
	},
	};
	return builtins;
})();

/**
 * Display-only tool names (model side never changes). obs_recall is the
 * observation pack's recall tool — the pack's own renderer calls it
 * "Recall Observation", so CC rows keep that name when they take over
 * (force mode); a bare `obs_recall` says nothing to a human.
 */
const DISPLAY_TOOL_NAMES: Record<string, string> = {
	obs_recall: "Recall Observation",
};

export const displayToolName = (name: string): string => DISPLAY_TOOL_NAMES[name] ?? name;

// ---- obs_recall display shaping (spec: display layer only) ----
//
// The pack's result text is a model protocol: a paging header the provider
// needs and a human doesn't. The original pack renderer rebuilt the visible
// rows from `details`; the CC row renders one human header in the original
// format. Source priority (spec P1-1 R3): the STRUCTURED `details` fields
// when they are complete (id non-empty string; offset/bytes/lines/
// nextOffset finite non-negative; eof boolean), else the two protocol lines
// parsed from the TEXT. Protocol lines are removed only when they actually
// match the known patterns — a details-bearing result whose text lacks them
// keeps its body verbatim; a partial-details/error result never gets a
// fabricated paging header.

const OBS_HEADER_LINE = /^\[obs_recall id=(obs_[0-9a-f]+) offset=(-?\d+) next_offset=(-?\d+) eof=(true|false)\]$/;
const OBS_CHUNK_LINE = /^\[chunk_bytes=(\d+) chunk_lines=(\d+); use next_offset to continue\]$/;

function humanBytesDisplay(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function recallOffsetLabel(offset: number): string {
	return offset > 0 ? `+${humanBytesDisplay(offset)}` : "start";
}

/** One human header line in the original pack format (single home). */
function humanRecallHeader(v: { bytes: number; lines: number; offset: number; nextOffset: number; eof: boolean }): string {
	return v.eof
		? `${humanBytesDisplay(v.bytes)} · ${v.lines} lines · ${recallOffsetLabel(v.offset)}→${recallOffsetLabel(v.nextOffset)} · end ✓`
		: `${humanBytesDisplay(v.bytes)} · ${v.lines} lines · ${recallOffsetLabel(v.offset)}→+${humanBytesDisplay(v.nextOffset)} · more ▸`;
}

/** Validated structural view of core's obs_recall `details` (or null). */
function parseObsDetails(details: unknown): { bytes: number; lines: number; offset: number; nextOffset: number; eof: boolean } | null {
	if (details == null || typeof details !== "object") return null;
	const d = details as Record<string, unknown>;
	if (typeof d.id !== "string" || d.id.length === 0) return null;
	const finiteNonNegative = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
	const bytes = finiteNonNegative(d.bytes);
	const lines = finiteNonNegative(d.lines);
	const offset = finiteNonNegative(d.offset);
	const nextOffset = finiteNonNegative(d.nextOffset);
	if (bytes === null || lines === null || offset === null || nextOffset === null) return null;
	if (typeof d.eof !== "boolean") return null;
	return { bytes, lines, offset, nextOffset, eof: d.eof };
}

export interface ObsRecallDisplayView {
	/** Human header line (original pack format), or null when the text is not a shaped recall page. */
	header: string | null;
	/** Display text: header + body when shaped, the original text otherwise. */
	text: string;
}

/** Shape an obs_recall result for display: protocol header → one human line. */
export const obsRecallDisplayView = (result: unknown): ObsRecallDisplayView => {
	const raw = textOfResult(result);
	// R3: details first — structured fields win when complete. The text body
	// keeps everything except lines that verifiably match the protocol
	// patterns (never a blind "drop the first two lines").
	const structured = parseObsDetails((result as { details?: unknown } | null | undefined)?.details);
	if (structured !== null) {
		const header = humanRecallHeader(structured);
		const body = raw
			.split("\n")
			.filter((line, idx) => !(idx < 2 && (OBS_HEADER_LINE.test(line) || OBS_CHUNK_LINE.test(line))))
			.join("\n")
			.replace(/^\n/, "");
		return { header, text: `${header}\n${body}` };
	}
	const lines = raw.split("\n");
	const headerMatch = OBS_HEADER_LINE.exec(lines[0] ?? "");
	const chunkMatch = OBS_CHUNK_LINE.exec(lines[1] ?? "");
	if (!headerMatch || !chunkMatch) return { header: null, text: raw };
	const [, , offsetRaw, nextOffsetRaw, eofRaw] = headerMatch;
	const [, bytesRaw, chunkLinesRaw] = chunkMatch;
	const header = humanRecallHeader({
		bytes: Number(bytesRaw),
		lines: Number(chunkLinesRaw),
		offset: Number(offsetRaw),
		nextOffset: Number(nextOffsetRaw),
		eof: eofRaw === "true",
	});
	const body = lines.slice(2).join("\n").replace(/^\n/, "");
	return { header, text: `${header}\n${body}` };
};

/**
 * Pseudo tool row for a packing event (user-directed design 2026-10-06):
 * when the OBS-09-SITES bus reports first-replacements, render the event
 * as ONE CC-style tool call row in the conversation tail (an aboveEditor
 * widget) — "⏺ Observation Packed(...)" + one detail line. Old tool rows
 * stay untouched (their components predate the publish anyway), nothing is
 * injected into the session transcript, and the row clears when the user
 * sends their next message.
 */
export interface PackedEventSite {
	readonly tool: string;
	readonly id: string;
	readonly avoidedTokens: number;
}

export const packedEventRows = (theme: CCTheme, sites: readonly PackedEventSite[], width: number): string[] => {
	if (sites.length === 0) return [];
	const tokens = sites.reduce((sum, site) => sum + Math.max(0, Math.round(site.avoidedTokens)), 0);
	const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
	const args =
		sites.length > 1
			? `${sites.length} results · ${compact(tokens)} tokens avoided`
			: `${sites[0]!.tool} · ${compact(tokens)} tokens avoided`;
	const call = ccCall(theme, "Observation Packed", args, "success").render(width)[0] ?? "";
	const latest = sites[sites.length - 1]!;
	const idTag = latest.id.length > 16 ? `${latest.id.slice(0, 16)}…` : latest.id;
	const detail = `${theme.fg("dim", "  ⎿  ")}${theme.fg("toolOutput", `${idTag} · recall via obs_recall`)}`;
	return [truncateToWidth(call, width, "…"), truncateToWidth(detail, width, "…")];
};

export const callArgsFor = (
	name: string,
	args: unknown,
	schemaFor?: (name: string) => import("./tool-summary.ts").ToolParamSchema | undefined,
): string => {
	if (name === "subagent") return subagentCallSummary((args ?? {}) as Record<string, unknown>);
	const summarize = builtinCallArgs[name];
	if (summarize) return summarize((args ?? {}) as Record<string, unknown>);
	// Generic schema-driven summary (spec P1-1 R2): a recognizable top-level
	// string param summarizes the row without a per-name branch. Empty args
	// and nothing-usable fall through to the bounded JSON dump.
	const generic = summarizeArgs(args, schemaFor?.(name));
	if (generic !== "") return clampCallSummary(generic);
	return clampCallSummary(JSON.stringify(args ?? {}));
};

// CC-style summary for pi-subagents' `subagent` tool (the JSON.stringify
// fallback put the whole workflowScript on the call row, escapes and all).
// Mirrors CC's Agent tool call row = agent type + human description
// (AgentTool/UI.tsx:411): `delegate · <task>` / `2×scout · <t1> · <t2> · +1`
// / `workflow <file>` / `<action> <target>`. Mode words ("call", raw lane
// keys) stay out of the headline.
const shortLane = (key: string): string => key.split(".").pop() || key;

const excerptLine = (text: string, max: number): string => {
	let clean = text.replace(/\s+/g, " ").trim();
	// Long absolute paths eat the headline budget with machine-specific
	// noise (/Users/x/y/proj → …/proj). Three+ segments only, so dates
	// like 2026/09/27 survive.
	clean = clean.replace(/(?:\/[\w@.-]+){3,}/g, (m) => `…/${m.split("/").filter(Boolean).pop()}`);
	clean = clean.replace(/~\/[\w@.-]+/g, (m) => `…/${m.slice(2)}`);
	// Leading directive labels ("READ-ONLY:", "只读：") carry no identifying info.
	clean = clean.replace(/^(READ[- ]?ONLY|只读)\s*[:：]?\s*/i, "");
	if (!clean) return "";
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

// Display-only lane extraction (key/agent/task string fields) from
// runs.all([...]) / runs.run("k", {...}) object literals. Dynamic ${...}
// templates are stripped first; backtick tasks match nothing and fall back
// to the lane key. Exact parity with pi-subagents' parser is not required —
// this is a headline summary, not execution metadata.
const lanesOfWorkflow = (script: string): Array<{ key: string; agent: string; task: string }> => {
	const lanes: Array<{ key: string; agent: string; task: string }> = [];
	const flat = script.replace(/\$\{[^{}]*\}/g, " ");
	for (const m of flat.matchAll(/\{([^{}]*)\}/g)) {
		const body = m[1]!;
		const field = (name: string): string =>
			body.match(new RegExp(`\\b${name}\\s*:\\s*(["'])([^"\\n]+?)\\1`))?.[2] ?? "";
		const key = field("key");
		const agent = field("agent");
		const task = field("task");
		if (key || agent || task) lanes.push({ key, agent, task });
	}
	return lanes;
};

export const subagentCallSummary = (args: Record<string, unknown>): string => {
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	const headline = (agent: string, task: string, fallback: string): string => {
		const who = agent ? shortLane(agent) : shortLane(fallback);
		const what = excerptLine(task, 20);
		return !what || what === who ? who : `${who} · ${what}`;
	};
	if (str(args.action)) {
		const target = str(args.agent) || str(args.id) || str(args.runId);
		return target ? `${str(args.action)} ${shortLane(target)}` : str(args.action);
	}
	// CC parity (AgentTool.tsx:83 + UI.tsx:411): the model-written short
	// label IS the headline — no agent name, no task excerpt.
	const description = str(args.label);
	if (description) return excerptLine(description, 20);
	const agent = str(args.agent);
	if (agent) return headline(agent, str(args.task), agent);
	const inlineScript = str(args.workflowScript);
	if (inlineScript) {
		const lanes = lanesOfWorkflow(inlineScript);
		if (lanes.length === 0) return "workflow";
		if (lanes.length === 1) return headline(lanes[0]!.agent, lanes[0]!.task, lanes[0]!.key);
		const agents = [...new Set(lanes.map((lane) => lane.agent).filter(Boolean))];
		const head = agents.length === 1
			? `${lanes.length}×${shortLane(agents[0]!)}`
			: agents.length > 1 ? agents.map((a) => shortLane(a)).join("+") : `${lanes.length} agents`;
		const body = lanes
			.slice(0, 2)
			.map((lane) => excerptLine(lane.task, 20) || shortLane(lane.key))
			.join(" · ");
		const rest = lanes.length > 2 ? ` · +${lanes.length - 2}` : "";
		return `${head} · ${body}${rest}`;
	}
	const scriptPath = str(args.workflowScriptPath);
	if (scriptPath) return `workflow ${scriptPath.split("/").pop() || scriptPath}`;
	return JSON.stringify(args);
};

// CC-style hint for pi's thinking-collapse binding (app.thinking.toggle):
// keyText yields "" outside a host session, hence the fallback.
export const thinkingToggleHint = (): string => keyText("app.thinking.toggle") || "ctrl+t";

// ⏺ dot state (CC ToolUseLoader.tsx): while running the dot is DIM (no
// color + dimColor) and blinks; resolved = success token (blue in the user's
// theme); error = red.
export type CCDotStatus = "running" | "success" | "error";
const DOT_COLOR: Record<CCDotStatus, string> = {
	running: "dim",
	success: "success",
	error: "error",
};
export const dotStatus = (rctx?: { isError?: boolean; isPartial?: boolean }): CCDotStatus => {
	if (rctx?.isError) return "error";
	if (rctx?.isPartial === false) return "success";
	return "running";
};

// `⏺ Tool(args)` call row: single line with args ellipsized to fit (CC
// style), so long commands can never wrap or misalign the dot. While the
// tool is running the dot is dim and blinks (⏺ ↔ space, same column
// width); terminal states keep a solid dot. Matches CC's ToolUseLoader +
// useBlink (BLINK_INTERVAL_MS = 600, phase = floor(time/600) % 2, one
// shared clock so rows blink in sync). The clock is read inside render()
// so the blink rides the existing per-frame re-render ticks (no timer).
export const blinkGlyph = (status: CCDotStatus, now: number): string =>
	status === "running" && Math.floor(now / 600) % 2 === 1 ? " " : "⏺";

// `badge` (e.g. "(MCP)") renders dim between the name and the args paren,
// reproducing CC's MCP userFacingName suffix (`server - tool (MCP)`).
export const ccCall = (theme: CCTheme, name: string, args: string, status: CCDotStatus, now?: number, badge?: string) => ({
	invalidate() {},
	render(width: number): string[] {
		const white = "\x1b[38;2;255;255;255m";
		const badgeText = badge ? ` ${theme.fg("dim", badge)}` : "";
		const head = `${theme.fg(DOT_COLOR[status], blinkGlyph(status, now ?? Date.now()))} ${white}${theme.bold(name)}${badgeText}(`;
		const avail = Math.max(1, width - visibleWidth(head) - 1);
		const shown = truncateToWidth(args, avail, "…");
		return [`${head}${shown})${RESET}`];
	},
});

/** Preserve the fused tool's then_run badge when its call renderer is replaced. */
export const ccThenRunCall = (theme: CCTheme, call: ReturnType<typeof ccCall>, command: unknown): ReturnType<typeof ccCall> => {
	if (typeof command !== "string" || command.trim() === "") return call;
	return {
		invalidate() {
			call.invalidate();
		},
		render(width: number): string[] {
			const badge = truncateToWidth(command, Math.max(1, width - 4), "…");
			// Theme.fg reads instance state; keep its receiver attached.
			return [...call.render(width), `  ${theme.fg("dim", `↳ then_run: ${badge}`)}`];
		},
	};
};

// `⎿  output` result rows: dim gutter, output wrapped and aligned under the
// gutter, collapsed preview with expand hint, red on error. Collapse is
// capped at MAX_RESULT_ROWS PHYSICAL rows: a single minified JSON line can
// wrap into dozens of terminal rows, so counting logical lines is not enough.
export const MAX_RESULT_ROWS = 3;

/**
 * MCP tool display name (SPEC 0.99-adapt MCP-01 → 2026-10-07 P1-1 R4):
 * the FIVE-shape display mirror of core's `lib/mcp-shape.ts`
 * `canonicalizeMcpShape` (replicated, not imported — the authority stays in
 * core; keep the two in sync via the shared-sample test against the real
 * core module):
 *   native1  `mcp__server__tool` / `mcp_server__tool`
 *   native2  `mcp__server_tool`  / `mcp_server_tool`
 *   proxy    tool name "mcp" with the real tool in `args.tool`
 *   direct   bare `server_tool` when the server id is on core's
 *            PI_CORE_MCP_DIRECT_SERVERS allowlist (same env var, same
 *            comma-split + trim + lowercase rules)
 *   bare     `mcp_*` with no separator left to split has no server/tool
 *            pair to display → null (core canonicalizes it; display does
 *            not claim it)
 * Renders as `server - tool` — the core of CC's MCP userFacingName; the
 * dim `(MCP)` badge is added by the call row (ccCall badge). Non-MCP →
 * null. R5: without `args` a bare proxy name "mcp" is NOT claimed — the
 * takeover matrix treats it as a normal third-party tool (auto-yield keeps
 * its own renderer); renderCall formats the badge only once the real
 * target is visible in args.
 */
const MCP_NAME = /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)__(.+)$/;
const MCP_NAME_FALLBACK = /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)_(.+)$/;
const DIRECT_NAME = /^([a-z][a-z0-9]*)_[a-z][a-z0-9_]*$/i;

/** Core's PI_CORE_MCP_DIRECT_SERVERS allowlist as a lowercase set. */
const directKnownServers = (): ReadonlySet<string> => {
	const raw = process.env.PI_CORE_MCP_DIRECT_SERVERS;
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
};

export const mcpDisplayName = (name: string, args?: unknown): string | null => {
	// proxy: the tool name IS "mcp" and the real tool sits in args.tool.
	const proxyTarget =
		name === "mcp" && args != null && typeof args === "object" && !Array.isArray(args)
			? (args as Record<string, unknown>).tool
			: "";
	const raw = name === "mcp" && typeof proxyTarget === "string" && proxyTarget !== "" ? proxyTarget : name;
	const m = MCP_NAME.exec(raw) ?? MCP_NAME_FALLBACK.exec(raw);
	if (m) return `${m[1]} - ${m[2]}`;
	// direct naming (exa_search): only when the leading server id is on the
	// configured known-servers list — otherwise any foo_bar extension tool
	// would be misclaimed.
	const direct = DIRECT_NAME.exec(raw);
	if (direct && directKnownServers().has(direct[1]!.toLowerCase())) {
		return `${direct[1]} - ${raw.slice(direct[1]!.length + 1)}`;
	}
	return null;
};

/** Generic `key=value` argument summary for MCP tools (values JSON-shortened). */
export const mcpArgsSummary = (args: unknown): string => {
	if (args == null || typeof args !== "object" || Array.isArray(args)) return "";
	const pairs = Object.entries(args as Record<string, unknown>)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" ");
	return pairs.length > 80 ? `${pairs.slice(0, 77)}…` : pairs;
};

// ── Component memo (plan A6) ──────────────────────────────────────────────
// (Result reference memo removed — spec 8.4 evaluation, see
// spec/notes/8.4-result-memo-evaluation.md: pi 1.0.x render() reuses the
// component tree updateDisplay built and every updateDisplay constructs a
// fresh result envelope, so a reference-keyed memo never hit on any real
// path — plain frames, partials, invalidate, expand, resize. Rebuilding
// here aligns with the host's own wholesale updateDisplay rebuild;
// ccResult's width cache below still absorbs resize rewraps.)

// ── Gutter-wrap layout (shared by the ccResult family and the skill row) ───
// One implementation of the CC expansion shape: wrap pre-painted logical
// lines at (width - 5), lay them out with a single pre-painted ⎿ gutter on
// the first physical row and a 5-space continuation indent on the rest.

export const GUTTER_CONT = "     ";

export const gutterWrapRows = (logicalLines: readonly string[], width: number, gutter: string): string[] => {
	const wrapW = Math.max(10, width - GUTTER_CONT.length);
	const physical: string[] = [];
	for (const line of logicalLines) physical.push(...wrapTextWithAnsi(line, wrapW));
	return physical.map((l, i) => `${i === 0 ? gutter : GUTTER_CONT}${l}`);
};

/** Wrap-once cache keyed by width (plan A6): render() runs every frame and
 * wrapping a large output costs one ANSI-aware wrap per logical line; a
 * width change (terminal resize) recomputes. */
export const createWidthCache = (): {
	clear(): void;
	serve(width: number, compute: (width: number) => string[]): string[];
} => {
	let cache: { width: number; rows: string[] } | null = null;
	return {
		clear() {
			cache = null;
		},
		serve(width, compute) {
			if (cache && cache.width === width) return cache.rows;
			const rows = compute(width);
			cache = { width, rows };
			return rows;
		},
	};
};

export const ccResult = (
	theme: CCTheme,
	name: string,
	result: unknown,
	options: { expanded?: boolean },
	isError: boolean,
) => {
	// Wrap-once cache (plan A6): render() is called every frame and wrapping a
	// large output costs one ANSI-aware wrap per logical line. All inputs the
	// output depends on are factory arguments, so a (width) key is sufficient;
	// a width change (terminal resize) recomputes.
	const wrapCache = createWidthCache();
	return {
		invalidate() {
			wrapCache.clear();
		},
		render(width: number): string[] {
			return wrapCache.serve(width, renderRows);
		},
	};

	function renderRows(width: number): string[] {
		const gutter = theme.fg("dim", "  ⎿  ");
		const cont = GUTTER_CONT;
		const paint = (s: string) => (isError ? theme.fg("error", s) : theme.fg("toolOutput", s));
		const expandHint = theme.fg("dim", `(${expandKeyHint()} to expand)`);

		// Wraps pre-colored logical lines into physical rows and, unless expanded,
		// caps the block at MAX_RESULT_ROWS rows total (expand hint included).
		const emit = (logicalLines: string[]): string[] => {
			const physical = gutterWrapRows(logicalLines, width, gutter);
			if (options.expanded || physical.length <= MAX_RESULT_ROWS) {
				return physical;
			}
			// Cap at MAX_RESULT_ROWS: keep the first rows as laid out (the slice
			// preserves physical indices, so the lead row keeps the gutter) and
			// close with the counted hint.
			const shown = physical.slice(0, MAX_RESULT_ROWS - 1);
			const rows = [...shown];
			rows.push(`${cont}${theme.fg("dim", `... +${physical.length - shown.length} lines`)} ${expandHint}`);
			return rows;
		};

		const output = textOfResult(result).replace(/\n+$/, "");
		const lines = output ? output.split("\n") : [];

		// Errors: red summary lines, like CC's `⎿  Error: ...`
		if (isError) {
			return emit((lines.length ? lines : ["Error"]).map((l) => theme.fg("error", l)));
		}

		// Edit: summary + colored diff
		if (name === "edit") {
			const diff = (result as { details?: { diff?: string } }).details?.diff;
			const logical = [lines[0] || "Updated file"];
			if (diff) logical.push(...renderDiff(diff).split("\n"));
			return emit(logical);
		}

		// Read collapsed: one-line summary, like CC
		if (name === "read" && !options.expanded) {
			return [
				`${gutter}${theme.fg("toolOutput", `Read ${lines.length} lines`)} ${theme.fg("dim", `(${expandKeyHint()} to expand)`)}`,
			];
		}

		if (lines.length === 0) {
			return [`${gutter}${theme.fg("toolOutput", "(no content)")}`];
		}

		// Generic collapsed preview
		return emit(lines.map(paint));
	}
};
