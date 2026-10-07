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

/**
 * Read pm's published status with the full fallback chain — a PURE read:
 * no subscription side effects (2026-10-03; the DC5b retry hook moved to
 * the explicit startCoreNotificationConsumer call sites — entry retries at
 * enable / session_start / render, same idempotent semantics, but the
 * read itself no longer hides an attach).
 */
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

/** Publish this extension's presence for pm's suppression probe (B7).
 * Spec P0-2: subscription-managed presence lives in lib/core-bus.ts
 * (createCoreBusClient handles declare/withdraw with ownership); this
 * helper remains for direct probe scenarios only. */
export function publishCcTuiCapability(globalStore: Record<string, unknown> = globalThis as never): void {
	// DC5b: notificationsConsumer declares that this build consumes the
	// core bus's notification tail queue itself — core then stops its
	// direct ctx.ui.notify forward for us (version negotiation, no
	// double display; older cores keep the forward).
	globalStore.__piCcTui = { version: 1, active: true, notificationsConsumer: true };
	// Legacy key (one compatibility cycle for older pm builds).
	globalStore.__ccTuiActive = true;
}

// ---- DC5b: notification tail-queue adapter ---------------------------------
//
// Subscription lifecycle lives in ONE place now — lib/core-bus.ts (spec
// 2026-10-07 P0-2/B1). This module contributes the notification adapter:
// diff the bounded tail queue by lastSeenId, starting from the handoff
// cursor (B3: max id at presence declaration on the same bus; 0 after a
// bus change). BOTH load orders (cctui-first and core-first) are handled by
// the client's retry points — the old "cctui loads before core" comment was
// half the truth.

import type { CoreBusAdapter, CoreBusHandoff, CoreSnapshotLike } from "./core-bus.ts";

type NotificationItem = { id: number; level: string; msg: string };

/**
 * Consume the core notification tail queue through a core-bus client.
 * Display failures advance the cursor anyway (one attempt per item, no
 * blocking, no replay loop) — the queue has no ACK, so this is "attempted",
 * not "shown".
 */
export function createNotificationAdapter(display: (msg: string, level: string) => void): CoreBusAdapter {
	let cursor = 0;
	const consume = (snapshot: CoreSnapshotLike | undefined): void => {
		const queue = snapshot?.notifications;
		if (!Array.isArray(queue)) return;
		for (const raw of queue) {
			if (raw == null || typeof raw !== "object") continue;
			const item = raw as Partial<NotificationItem>;
			if (typeof item.id !== "number" || !Number.isFinite(item.id)) continue;
			if (typeof item.msg !== "string" || typeof item.level !== "string") continue;
			if (item.id <= cursor) continue;
			cursor = item.id; // advance BEFORE attempting display (single attempt)
			try {
				display(item.msg, item.level);
			} catch {
				// Stale sink: drop this one rather than replay-loop.
			}
		}
	};
	return {
		onAttach(snapshot: CoreSnapshotLike, handoff: CoreBusHandoff) {
			// B3: same bus → continue from the declaration cursor (the
			// fallback already showed earlier items); new bus → its queue
			// was never displayed (our presence suppressed both paths).
			cursor = handoff.sameBusAsPresence ? handoff.presenceMaxNotifyId : 0;
			consume(snapshot);
		},
		onSnapshot(snapshot) {
			consume(snapshot);
		},
		onDetach() {
			cursor = 0;
		},
	};
}
