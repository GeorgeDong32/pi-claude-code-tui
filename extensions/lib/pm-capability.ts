/**
 * Consumer side of the permission-modes capability channel (plan B7).
 *
 * pm publishes a single typed, versioned object on
 * globalThis.__piPermissionModes; the legacy untyped keys
 * (__pmWorkingStats string with a literal prefix, and the env-var mode
 * channel) remain as fallbacks for one compatibility cycle. All reads go
 * through here so the priority chain has one owner and one test surface.
 */

/** Duck-typed mirror of pm's PmCapability. */
export interface PmCapabilityLike {
	version?: number;
	active?: boolean;
	mode?: string;
	workingStats?: string | null;
}

export interface PmStatus {
	/** Stats segment without parentheses, e.g. "↑1.2k · ↓300 · $0.012". */
	workingStats: string;
	/** Current permission mode ("ask" | "plan" | "auto" | "bypass"), "" if unknown. */
	mode: string;
}

const CAPABILITY_KEY = "__piPermissionModes";
const LEGACY_STATS_KEY = "__pmWorkingStats";
export const PM_MODE_ENV = "PERMISSION_MODES_INHERITED_MODE";

function isVersioned(value: PmCapabilityLike | undefined): value is PmCapabilityLike {
	return value?.version !== undefined && value.version >= 1;
}

/** Read pm's published status with the full fallback chain. */
export function readPmStatus(globalStore: Record<string, unknown> = globalThis as never): PmStatus {
	const capability = globalStore[CAPABILITY_KEY] as PmCapabilityLike | undefined;
	if (isVersioned(capability)) {
		const legacy = globalStore[LEGACY_STATS_KEY];
		return {
			workingStats:
				typeof capability.workingStats === "string" && capability.workingStats.length > 0
					? capability.workingStats
					: typeof legacy === "string" && legacy.length > 0
						? legacy.replace(/^\(/, "").replace(/\)$/, "")
						: "",
			mode: typeof capability.mode === "string" ? capability.mode : "",
		};
	}
	// Older pm builds: legacy untyped keys.
	const legacy = globalStore[LEGACY_STATS_KEY];
	const workingStats =
		typeof legacy === "string" && legacy.length > 0 ? legacy.replace(/^\(/, "").replace(/\)$/, "") : "";
	return { workingStats, mode: process.env[PM_MODE_ENV]?.trim() ?? "" };
}

/** Publish this extension's presence for pm's suppression probe (B7). */
export function publishCcTuiCapability(globalStore: Record<string, unknown> = globalThis as never): void {
	globalStore.__piCcTui = { version: 1, active: true };
	// Legacy key (one compatibility cycle for older pm builds).
	globalStore.__ccTuiActive = true;
}

export function withdrawCcTuiCapability(globalStore: Record<string, unknown> = globalThis as never): void {
	delete globalStore.__piCcTui;
	delete globalStore.__ccTuiActive;
}
