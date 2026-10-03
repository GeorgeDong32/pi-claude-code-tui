/**
 * Host-state reads behind one seam (extracted 2026-10-03).
 *
 * Reading volatile host state from pi (thinking/effort level) must never
 * throw — render callbacks run on stacks pi cannot catch, and a throw
 * kills the whole TUI (AGENTS.md trap 1). The defensive shape
 * (duck-typed probe + try/catch) used to be copy-pasted at three call
 * sites, with a FOURTH (the startup header) missing the guard entirely —
 * proof that this knowledge does not stay consistent when spread across
 * callers. One function now owns it.
 */

export type EffortSource = { getThinkingLevel?: () => string | undefined };

/** Read the thinking/effort level; undefined when the host lacks the API,
 * hides it, or throws (older hosts, non-TUI modes). Never throws. */
export const readEffortLevel = (pi: EffortSource): string | undefined => {
	try {
		return pi.getThinkingLevel?.();
	} catch {
		return undefined;
	}
};
