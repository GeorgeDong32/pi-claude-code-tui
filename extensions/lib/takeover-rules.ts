/**
 * Takeover decision matrix (single home, extracted 2026-10-03).
 *
 * Which tool rows does this package's CC rendering own? The answer used to
 * live as three slightly different inline condition chains inside the
 * prototype patch (getCallRenderer / getResultRenderer / getRenderShell) —
 * the exact spot two review fixes (edf4fce, eb4dc7c) had to hunt through.
 * The matrix is now one pure function, table-tested exhaustively below.
 *
 * Slot semantics:
 * - "call"   → who renders the ⏺ Tool(args) call row
 * - "result" → who renders the ⎿ result block (may differ from call:
 *              FORCE_RESULT_EXEMPT keeps live information-dense renderers)
 * - "shell"  → flat "self" container vs pi's pending/success box
 *
 * Rules (SPEC 0.99-adapt DEC-03/MCP-02, TR D1):
 * - The user switches (enabled / toolRowsEnabled) always gate everything.
 * - Official MCP tools: taken over on purpose — the CC row is the
 *   user-asked shape; the builtin check and auto-yield below only guard
 *   non-MCP tools.
 * - Builtin seven: already owned via registerToolOverrides; the prototype
 *   path leaves them alone.
 * - Third-party with its own renderer: auto-yield (another TUI extension
 *   may own the visuals); force mode (/claude-tools on) takes over —
 *   except the result slot of exempt tools (subagent live workflow card,
 *   obs_recall paged view), which must not flatten into a 3-row preview.
 * - Third-party with NO renderer: taken over even in auto mode — there is
 *   nothing to yield to.
 */

export type TakeoverSlot = "call" | "result" | "shell";

export interface TakeoverInput {
	/** The /claude-tui master switch. */
	enabled: boolean;
	/** Tool rows on (prefs / CC_TUI_TOOL_ROWS env switch). */
	toolRowsEnabled: boolean;
	/** Force mode: user explicitly asked for CC rows (/claude-tools on). */
	forced: boolean;
	/** The tool name matches an official MCP tool (mcpDisplayName hit). */
	isMcp: boolean;
	/** The component carries pi's builtin tool definition. */
	isBuiltin: boolean;
	/**
	 * This slot has something to fall back to: a definition-supplied
	 * renderer (call/result) or a toolDefinition on the component (shell).
	 */
	hasOrig: boolean;
	toolName: string;
	slot: TakeoverSlot;
}

export type TakeoverDecision = "orig" | "cc";

/**
 * Tools whose own RESULT renderer is live, information-dense UI that force
 * mode must NOT flatten into a 3-row preview: pi-subagents' `subagent`
 * renders a live workflow card (per-agent progress, tokens, checklists)
 * inline, and obs_recall's result is a dense paged view. Call rows stay
 * ours in force mode; only the result block is exempt.
 */
export const FORCE_RESULT_EXEMPT = new Set(["subagent", "obs_recall"]);

export const decideTakeover = (input: TakeoverInput): TakeoverDecision => {
	const { enabled, toolRowsEnabled, forced, isMcp, isBuiltin, hasOrig, toolName, slot } = input;
	if (!enabled || !toolRowsEnabled) return "orig";
	if (slot === "shell") {
		// Flat container only for registered third-party/MCP tools carrying a
		// definition — the builtin seven are pre-flattened by their own
		// registration (renderShell: "self" at registerTool time).
		return (isMcp || !isBuiltin) && hasOrig ? "cc" : "orig";
	}
	if (isMcp) return "cc";
	if (isBuiltin) return "orig";
	if (!hasOrig) return "cc";
	if (!forced) return "orig";
	if (slot === "result" && FORCE_RESULT_EXEMPT.has(toolName)) return "orig";
	return "cc";
};
