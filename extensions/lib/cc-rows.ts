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
	// ── pi-claude-code-core tools: CC-style one-line summaries instead of the
	// JSON fallback (which put whole goal drafts / recall queries on the row).
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
	// ── core: goal family — objective/summary headline, never the draft body.
	create_goal: (a) => shortText(a.objective ?? a.goal ?? a.title),
	propose_goal_draft: (a) => shortText(a.objective ?? a.goal ?? a.title),
	update_goal: (a) => shortText(a.objective ?? a.note ?? a.status),
	get_goal: () => "",
	pause_goal: (a) => shortText(a.reason, 40),
	goal_questionnaire: (a) => shortText(a.topic ?? a.question),
	// ── core: memory / recall — query headline, ids only.
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
	// ── core: review / plan — short nouns.
	pi_review_report: (a) => shortText(a.mode ?? a.scope ?? a.base, 40),
	plan_ready: (a) => shortText(a.plan ?? a.summary, 40),
	step_complete: (a) => shortText(a.step ?? a.result, 40),
	};
	return builtins;
})();

export const callArgsFor = (name: string, args: unknown): string => {
	if (name === "subagent") return subagentCallSummary((args ?? {}) as Record<string, unknown>);
	const table = builtinCallArgs;
	const summarize = table[name] ?? ((a) => clampCallSummary(JSON.stringify(a ?? {})));
	return summarize((args ?? {}) as Record<string, unknown>);
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
 * MCP tool display name (SPEC 0.99-adapt MCP-01): `mcp__server__tool` (and
 * the single-underscore variant) renders as `server - tool` — the core of
 * CC's MCP userFacingName (`services/mcp/client.ts`:
 * `${serverName} - ${displayName} (MCP)`); the dim `(MCP)` badge is added
 * by the call row (ccCall badge), mirroring CC's AssistantToolUseMessage
 * which renders the userFacingName verbatim. Non-MCP names → null.
 * Same canonicalization shape as core mcp-gov's family.ts.
 */
const MCP_NAME = /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)__(.+)$/;
const MCP_NAME_FALLBACK = /^(?:mcp__|mcp_)([A-Za-z0-9_-]+)_(.+)$/;

export const mcpDisplayName = (name: string): string | null => {
	const m = MCP_NAME.exec(name) ?? MCP_NAME_FALLBACK.exec(name);
	return m ? `${m[1]} - ${m[2]}` : null;
};

/** Generic `key=value` argument summary for MCP tools (values JSON-shortened). */
export const mcpArgsSummary = (args: unknown): string => {
	if (args == null || typeof args !== "object" || Array.isArray(args)) return "";
	const pairs = Object.entries(args as Record<string, unknown>)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" ");
	return pairs.length > 80 ? `${pairs.slice(0, 77)}…` : pairs;
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
	let renderCache: { width: number; rows: string[] } | null = null;
	return {
		invalidate() {
			renderCache = null;
		},
		render(width: number): string[] {
			if (renderCache && renderCache.width === width) return renderCache.rows;
			const rows = renderRows(width);
			renderCache = { width, rows };
			return rows;
		},
	};

	function renderRows(width: number): string[] {
		const gutter = theme.fg("dim", "  ⎿  ");
		const cont = "     ";
		const paint = (s: string) => (isError ? theme.fg("error", s) : theme.fg("toolOutput", s));
		const wrapW = Math.max(10, width - cont.length);
		const expandHint = theme.fg("dim", `(${expandKeyHint()} to expand)`);

		// Wraps pre-colored logical lines into physical rows and, unless expanded,
		// caps the block at MAX_RESULT_ROWS rows total (expand hint included).
		const emit = (logicalLines: string[]): string[] => {
			const physical: string[] = [];
			for (const line of logicalLines) physical.push(...wrapTextWithAnsi(line, wrapW));
			if (options.expanded || physical.length <= MAX_RESULT_ROWS) {
				return physical.map((l, i) => `${i === 0 ? gutter : cont}${l}`);
			}
			const shown = physical.slice(0, MAX_RESULT_ROWS - 1);
			const rows = shown.map((l, i) => `${i === 0 ? gutter : cont}${l}`);
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
