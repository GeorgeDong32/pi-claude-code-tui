/**
 * Takeover decision matrix (single home, extracted 2026-10-03; migrated to
 * the pi.registerToolRenderer resolver channel 2026-10 — spec
 * 2026-10-03-pi-1.0-tool-renderer-migration).
 *
 * Which tool rows does this package's CC rendering own? The answer used to
 * live as three slightly different inline condition chains inside the
 * prototype patch (getCallRenderer / getResultRenderer / getRenderShell) —
 * the exact spot two review fixes (edf4fce, eb4dc7c) had to hunt through.
 * The matrix is one pure function, table-tested exhaustively below.
 *
 * Slot semantics (post-migration):
 * - "call"   → who renders the ⏺ Tool(args) call row
 * - "result" → who renders the ⎿ result block (may differ from call:
 *              FORCE_RESULT_EXEMPT keeps live information-dense renderers)
 * The shell slot left the matrix: planResolverTakeover derives it (DEC-05).
 *
 * Rules (0.99-adapt DEC-03/MCP-02, TR D1; 1.0 migration DEC-04/05):
 * - The user switches (enabled / toolRowsEnabled) always gate everything.
 * - Official MCP tools: taken over on purpose — the CC row is the
 *   user-asked shape; the builtin check and auto-yield below only guard
 *   non-MCP tools.
 * - Builtin seven: ours whenever rows are on. Pre-migration this happened
 *   via registerToolOverrides (registerTool re-registration); on the
 *   resolver channel the same effect needs isBuiltin → "cc" here.
 *   BUILTIN_SEVEN membership is load-bearing: pi's builtin renderer table
 *   also has "powershell", which must stay OUT (it renders stock under the
 *   resolver path — putting it in would flip it to CC rows).
 * - Third-party with its own renderer: auto-yield (another TUI extension
 *   may own the visuals); force mode (/claude-tools on) takes over —
 *   except the result slot of exempt tools (subagent live workflow card,
 *   obs_recall paged view), which must not flatten into a 3-row preview.
 * - Third-party with NO renderer: taken over even in auto mode — there is
 *   nothing to yield to.
 */

export type TakeoverSlot = "call" | "result";

export interface TakeoverInput {
	/** The /claude-tui master switch. */
	enabled: boolean;
	/** Tool rows on (prefs / CC_TUI_TOOL_ROWS env switch). */
	toolRowsEnabled: boolean;
	/** Force mode: user explicitly asked for CC rows (/claude-tools on). */
	forced: boolean;
	/** The tool name matches an official MCP tool (mcpDisplayName hit). */
	isMcp: boolean;
	/** The tool is one of the builtin seven (isBuiltinToolName). */
	isBuiltin: boolean;
	/**
	 * This slot has something to fall back to: a next()-supplied renderCall
	 * (call slot) or renderResult (result slot).
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

/**
 * The builtin seven whose rows we re-render CC-style. Pre-migration these
 * were owned by re-registering the definitions (registerToolOverrides);
 * the resolver path recognizes them by name instead. pi's builtin renderer
 * table has an eighth key, powershell — deliberately NOT here (r2 review:
 * the seven-name set is load-bearing; adding it would flip powershell from
 * stock to CC rows on rows-on).
 */
export const BUILTIN_SEVEN = new Set(["read", "bash", "grep", "find", "ls", "write", "edit"]);

export const isBuiltinToolName = (name: string): boolean => BUILTIN_SEVEN.has(name);

export const decideTakeover = (input: TakeoverInput): TakeoverDecision => {
	const { enabled, toolRowsEnabled, forced, isMcp, isBuiltin, hasOrig, toolName, slot } = input;
	if (!enabled || !toolRowsEnabled) return "orig";
	if (isMcp) return "cc";
	if (isBuiltin) return "cc";
	if (!hasOrig) return "cc";
	if (!forced) return "orig";
	if (slot === "result" && FORCE_RESULT_EXEMPT.has(toolName)) return "orig";
	return "cc";
};

// ── Resolver-channel planning (pi >= 1.0.1) ──

/** resolver 合并决策输入（spec DEC-06）；hasOrig 按槽位分离。 */
export interface ResolverTakeoverInput {
	/** enabled && 最新 ctx.mode === "tui"（入口维护的通道旗标）。 */
	channelActive: boolean;
	/** Tool rows on (prefs / env / auto-detect 合成的有效开关)。 */
	toolRowsEnabled: boolean;
	/** Force mode: user explicitly asked for CC rows (/claude-tools on)。 */
	forced: boolean;
	/** mcpDisplayName(toolName) !== null（调用方算）。 */
	isMcp: boolean;
	/** isBuiltinToolName(toolName)。 */
	isBuiltin: boolean;
	/** Boolean(next()?.renderCall)。 */
	hasOrigCall: boolean;
	/** Boolean(next()?.renderResult)。 */
	hasOrigResult: boolean;
	toolName: string;
}

/** Per-construction renderer plan; undefined ⇒ yield entirely (return next()). */
export interface ResolverTakeoverPlan {
	call: TakeoverDecision;
	result: TakeoverDecision;
	/** DEC-05 shell derivation: "self" flat container vs next()'s shell. */
	shell: "self" | "orig";
}

/**
 * Plan the merged ToolRenderers for one resolver call (= one
 * ToolExecutionComponent construction; pi resolves per construction with no
 * caching — DEC-07). Composition of the single-arbiter decideTakeover per
 * slot plus the DEC-05 shell derivation:
 * - call=cc ⇒ "self" (builtin/MCP/forced takeover — what registerCC's
 *   renderShell:"self" pre-set used to do);
 * - call=orig + non-builtin ⇒ STILL "self": today's yield path keeps the
 *   flat container for definition-carrying third-party tools (P1-1 —
 *   SoL-Pi fused write/edit, obs_recall, …);
 * - builtin + call=orig is unreachable (isBuiltin → cc when rows are on);
 *   the "orig" member stays in the type as the documented fallback.
 */
export const planResolverTakeover = (i: ResolverTakeoverInput): ResolverTakeoverPlan | undefined => {
	if (!i.channelActive || !i.toolRowsEnabled) return undefined;
	const call = decideTakeover({
		enabled: true,
		toolRowsEnabled: true,
		forced: i.forced,
		isMcp: i.isMcp,
		isBuiltin: i.isBuiltin,
		hasOrig: i.hasOrigCall,
		toolName: i.toolName,
		slot: "call",
	});
	const result = decideTakeover({
		enabled: true,
		toolRowsEnabled: true,
		forced: i.forced,
		isMcp: i.isMcp,
		isBuiltin: i.isBuiltin,
		hasOrig: i.hasOrigResult,
		toolName: i.toolName,
		slot: "result",
	});
	const shell: "self" | "orig" = call === "cc" || !i.isBuiltin ? "self" : "orig";
	return { call, result, shell };
};
