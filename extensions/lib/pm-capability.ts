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
	/** DC1: mode presentation material single-sourced from core's MODE_META. */
	meta?: Readonly<Record<string, { icon: string; label: string; role: string }>>;
}

/** Duck-typed mirror of one mode's presentation material. */
export interface PmModeMeta {
	icon: string;
	label: string;
	role: string;
}

export interface PmStatus {
	/** Stats segment without parentheses, e.g. "↑1.2k · ↓300 · $0.012". */
	workingStats: string;
	/** Current permission mode ("ask" | "plan" | "auto" | "bypass"), "" if unknown. */
	mode: string;
	/** Mode presentation material from the bus projection; absent on older cores. */
	meta?: Readonly<Record<string, PmModeMeta>>;
}

const CAPABILITY_KEY = "__piPermissionModes";
const LEGACY_STATS_KEY = "__pmWorkingStats";
const SNAPSHOT_KEY = "__piClaudeCodeCore";
export const PM_MODE_ENV = "PERMISSION_MODES_INHERITED_MODE";

function isVersioned(value: PmCapabilityLike | undefined): value is PmCapabilityLike {
	return value?.version !== undefined && value.version >= 1;
}

/** Duck-typed mirror of the bus snapshot's modes channel (primary source). */
interface SnapshotLike {
	version?: number;
	modes?: {
		mode?: string;
		workingStats?: string | null;
		meta?: Readonly<Record<string, { icon: string; label: string; role: string }>>;
	};
}

function readLegacyStats(globalStore: Record<string, unknown>): string {
	const legacy = globalStore[LEGACY_STATS_KEY];
	return typeof legacy === "string" && legacy.length > 0 ? legacy.replace(/^\(/, "").replace(/\)$/, "") : "";
}

/** Read pm's published status with the full fallback chain. */
export function readPmStatus(globalStore: Record<string, unknown> = globalThis as never): PmStatus {
	// DC5: the bus snapshot itself is the primary source (v1+; always-full
	// stats under DC5 cores). The legacy projection below stays for older
	// core builds until the version-gated removal window closes.
	const snap = globalStore[SNAPSHOT_KEY] as SnapshotLike | undefined;
	if (snap?.version !== undefined && snap.version >= 1 && snap.modes) {
		const m = snap.modes;
		const workingStats =
			typeof m.workingStats === "string" && m.workingStats.length > 0
				? m.workingStats
				: readLegacyStats(globalStore);
		return {
			workingStats,
			mode: typeof m.mode === "string" ? m.mode : "",
			...(m.meta ? { meta: m.meta } : {}),
		};
	}
	const capability = globalStore[CAPABILITY_KEY] as PmCapabilityLike | undefined;
	if (isVersioned(capability)) {
		const legacy = globalStore[LEGACY_STATS_KEY];
		// Conditional spread: absent meta keeps the historical two-field shape
		// (deepEqual tests pin it).
		return {
			workingStats:
				typeof capability.workingStats === "string" && capability.workingStats.length > 0
					? capability.workingStats
					: typeof legacy === "string" && legacy.length > 0
						? legacy.replace(/^\(/, "").replace(/\)$/, "")
						: "",
			mode: typeof capability.mode === "string" ? capability.mode : "",
			...(capability.meta ? { meta: capability.meta } : {}),
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
