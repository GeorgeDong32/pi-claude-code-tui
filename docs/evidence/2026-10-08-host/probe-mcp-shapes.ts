/**
 * Isolated probe extension for H-T2 MCP display shapes (2026-10-08 follow-up §4A).
 *
 * Registers the two MCP shapes the real host cannot produce from a bare
 * single-session setup, so the TUI's REAL render path can be exercised with
 * controlled inputs (source documented in the evidence LEDGER — this is a
 * probe, not a product surface):
 *   - `mcp`  : the PROXY shape — tool name "mcp", real target in args.tool
 *              (the form pi-subagents' codemode bridge historically emits;
 *              pi 1.0.2 exposes only codemode/deferred/direct/hidden).
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
		description: "Probe-only proxy-shaped MCP tool: passes {tool, args} through and echoes.",
		parameters: Type.Object({
			tool: Type.String({ description: "The real MCP tool name, e.g. mcp__dummy__echo_search." }),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			return { content: [{ type: "text", text: `probe proxy echo for ${params.tool}` }], details: {} };
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
