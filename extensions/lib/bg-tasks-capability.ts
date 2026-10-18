/**
 * Consumer side of the bg-shell task channel (CC footer pill parity).
 *
 * core's bg-shell module keeps its live task registry on a well-known
 * `Symbol.for` global — cross-`/reload` survival is that module's own
 * design. This is a render-time PULL, not a subscription: the footer counts
 * running tasks each frame, exactly like `readPmStatus` reads the pm
 * capability chain at render time. Registry absent or misshapen → 0
 * (fail-open; a missing core must never break the footer).
 */

/** Duck-typed mirror of bg-shell's registry surface (tasks map + state). */
export interface BgShellRegistryLike {
	tasks?: Map<string, { state?: string }>;
}

const REGISTRY_KEY = Symbol.for("cc-core.bg-shell.registry");

/** Number of bg-shell tasks currently running; 0 when core is absent. */
export function runningBgShells(): number {
	const holder = (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY] as
		| BgShellRegistryLike
		| undefined;
	if (holder === undefined || typeof holder !== "object") return 0;
	const tasks = holder.tasks;
	if (!(tasks instanceof Map)) return 0;
	let running = 0;
	for (const task of tasks.values()) if (task !== null && typeof task === "object" && task.state === "running")
		running++;
	return running;
}

/**
 * CC `pillLabel` parity for the local_bash case: `1 shell` / `N shells`.
 * Empty string when there is nothing to show (CC renders no pill at 0).
 */
export function bgShellPillText(count: number): string {
	if (count <= 0) return "";
	return count === 1 ? "1 shell" : `${count} shells`;
}
