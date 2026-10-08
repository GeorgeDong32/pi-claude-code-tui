/**
 * Isolated probe extension for H-T2 MCP display shapes (2026-10-08 follow-up §4A;
 * 2026-10-09 §4B bare-MCP acceptance).
 *
 * Registers the MCP shapes the real host cannot produce from a bare
 * single-session setup, so the TUI's REAL render path can be exercised with
 * controlled inputs (source documented in the evidence LEDGER — this is a
 * probe, not a product surface):
 *   - `mcp`  : the PROXY shape — tool name "mcp", real target in args.tool
 *              (the form pi-subagents' codemode bridge historically emits;
 *              pi 1.0.2 exposes only codemode/deferred/direct/hidden).
 *              2026-10-09: `tool` is OPTIONAL and untyped so the model can
 *              also send the DEGENERATE proxy inputs the bare-MCP acceptance
 *              needs — args.tool missing / empty / not a string / a string
 *              that does not parse as any MCP shape — plus the valid target
 *              as the correctly-identified control. The production mirror
 *              (mcpDisplayName) must never badge, mislabel, lose the args,
 *              or throw on any of them.
 *   - `mcp_bareprobe` : the BARE mcp_* shape — no separator to split, the
 *              display mirror must NOT claim it (canonicalization is core's).
 * Tools only echo their inputs; nothing touches disk or network.
 */
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

export default function probeMcpShapes(pi: ExtensionAPI): void {
	// Each tool registers through the real pi factory path.
	pi.registerTool(defineTool({
		name: "mcp",
		label: "MCP (proxy probe)",
		description: "Probe-only proxy-shaped MCP tool. Accepts ANY arguments: tool may be a real MCP tool name (e.g. mcp__dummy__echo_search), or missing, empty, non-string, or unparseable — echo only.",
		parameters: Type.Object({
			tool: Type.Optional(Type.Unknown({ description: "Optional/any on purpose: the degenerate-input acceptance sends missing/empty/garbage values." })),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			return { content: [{ type: "text", text: `probe proxy echo for ${JSON.stringify(params)}` }], details: {} };
		},
	}));
	pi.registerTool(defineTool({
		name: "dummy_echo",
		label: "Direct-named probe",
		description: "Probe-only direct-named shape: bare server_tool name claimed via PI_CORE_MCP_DIRECT_SERVERS=dummy.",
		parameters: Type.Object({
			note: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			return { content: [{ type: "text", text: `probe direct echo ${params.note ?? ""}`.trim() }], details: {} };
		},
	}));
	pi.registerTool(defineTool({
		name: "mcp_bareprobe",
		label: "MCP (bare probe)",
		description: "Probe-only bare mcp_* tool name with no server separator; display must not badge it.",
		parameters: Type.Object({
			note: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			return { content: [{ type: "text", text: `probe bare echo ${params.note ?? ""}`.trim() }], details: {} };
		},
	}));
}
