/**
 * Core-bus client (spec 2026-10-07 P0-2, decisions B1–B6).
 *
 * ONE subscription owner for every core bus channel this package consumes
 * (notifications tail queue, observation-pack sites, display.footer). The
 * consumer modules (pm-capability.ts, obs-savings.ts) used to each hand-roll
 * the same attach/retry/dedupe structure — the same load-order/reload bug
 * had to be fixed twice, and a third channel (footer) would have copied it
 * again. They now provide thin adapters over this client.
 *
 * Load order — BOTH directions occur (core-first and cctui-first in real
 * settings.json); this client handles either:
 *   activate()  capture the handoff baseline (bus identity, notification
 *               max id, existing site keys) → declare presence → attach.
 *               Idempotent: a repeated activate never re-truncates the
 *               baseline (C9).
 *   retry()     O(1) health check on the hot path (render frames): fixed
 *               property reads + one identity comparison, no allocation
 *               while attached to an unchanged bus. Re-attaches when the
 *               bus identity changed (reload / late load).
 *   close()     idempotent teardown — unsubscribe, detach adapters, and
 *               withdraw ONLY the presence object this client published
 *               (a newer instance's keys survive an old close).
 *
 * Identity (B2): prefer the snapshot's `instance` token (core P1-1+); fall
 * back to the `onChange` register closure — core's bus reuses one register
 * closure per instance across publishes, so function identity is a stable
 * per-bus key on old cores. v1 snapshots (no onChange) are not
 * identifiable → not subscribed.
 *
 * Handoff cursor (B3): the notification cursor starts at the max id seen at
 * PRESENCE DECLARATION when attaching to the same bus (items the fallback
 * already displayed before our declaration are not replayed), and at 0
 * after a bus change (a fresh bus's queue was never shown — our live
 * presence suppressed both core's forward and its fallback).
 *
 * Limits kept honest (no fake ACK protocol): the core tail queue is capped
 * at 20 with no acknowledgement — items pushed out before attach are gone;
 * the observation channel keeps only the LATEST batch — earlier batches
 * overwritten in the window before attach cannot be recovered.
 */

// ---- snapshot surface (duck-typed mirror of core's CoreSnapshot) ---------

export interface CoreSnapshotLike {
	version?: number;
	revision?: number;
	/** Future core P1-1: explicit per-bus identity token. */
	instance?: unknown;
	/** v2+ data-carried subscription point. */
	onChange?: (fn: () => void) => () => void;
	notifications?: readonly unknown[];
	observation?: { sites?: unknown };
	display?: { footer?: readonly unknown[] };
}

export interface ObsSiteLike {
	readonly tool: string;
	readonly id: string;
	readonly avoidedTokens: number;
	readonly toolCallId?: string;
}

/** Sites key: JSON tuple — collision-free, unlike concatenated colon strings. */
export const obsSiteKey = (site: ObsSiteLike): string =>
	JSON.stringify([site.tool, site.id, site.toolCallId ?? null, site.avoidedTokens]);

const SNAPSHOT_KEY = "__piClaudeCodeCore";
export const CORE_SNAPSHOT_KEY = SNAPSHOT_KEY;
const PRESENCE_KEY = "__piCcTui";
const LEGACY_PRESENCE_KEY = "__ccTuiActive";

export const snapshotOf = (store: Record<string, unknown>): CoreSnapshotLike | undefined =>
	store[SNAPSHOT_KEY] as CoreSnapshotLike | undefined;

/**
 * Stable identity of the bus behind a snapshot: the explicit `instance`
 * token when present, else the register closure (stable per bus instance).
 * null = v1 / not identifiable → do not subscribe.
 */
const INSTANCE_TYPES = new Set(["string", "number", "bigint", "symbol"]);

export const busIdentityOf = (snapshot: CoreSnapshotLike | undefined): unknown => {
	if (!snapshot) return null;
	const instance = snapshot.instance;
	if (instance != null && (typeof instance === "object" || INSTANCE_TYPES.has(typeof instance))) {
		return instance;
	}
	return typeof snapshot.onChange === "function" ? snapshot.onChange : null;
};

/** Max notification id in the (bounded) tail queue, 0 when absent/invalid. */
export const maxNotificationIdOf = (snapshot: CoreSnapshotLike | undefined): number => {
	const queue = snapshot?.notifications;
	if (!Array.isArray(queue) || queue.length === 0) return 0;
	const last = queue[queue.length - 1] as { id?: unknown };
	return typeof last?.id === "number" && Number.isFinite(last.id) ? last.id : 0;
};

/** Shape-checked read of the observation sites channel. */
export const obsSitesOf = (snapshot: CoreSnapshotLike | undefined): ObsSiteLike[] => {
	const sites = snapshot?.observation?.sites;
	if (!Array.isArray(sites)) return [];
	const parsed: ObsSiteLike[] = [];
	for (const site of sites) {
		if (typeof site !== "object" || site === null) continue;
		const { tool, id, avoidedTokens, toolCallId } = site as Record<string, unknown>;
		if (typeof tool !== "string" || typeof id !== "string" || typeof avoidedTokens !== "number") continue;
		parsed.push(typeof toolCallId === "string" ? { tool, id, avoidedTokens, toolCallId } : { tool, id, avoidedTokens });
	}
	return parsed;
};

// ---- adapter seam ----------------------------------------------------------

export interface CoreBusHandoff {
	/** Identity of the bus the client attached to. */
	busId: unknown;
	/** The attached bus is the one the presence was declared on. */
	sameBusAsPresence: boolean;
	/** Notification cursor start for a same-bus attach (B3). */
	presenceMaxNotifyId: number;
	/** Site keys already visible at presence declaration (history baseline). */
	obsBaselineKeys: ReadonlySet<string>;
}

export interface CoreBusAdapter {
	/** Attached (or re-attached after a bus change): consume the CURRENT snapshot now. */
	onAttach?(snapshot: CoreSnapshotLike, handoff: CoreBusHandoff): void;
	/** A publish on the attached bus. */
	onSnapshot?(snapshot: CoreSnapshotLike): void;
	/** Detached (bus changed or close): drop per-bus state. */
	onDetach?(): void;
}

export interface CoreBusClient {
	activate(): void;
	retry(): boolean;
	close(): void;
}

export interface CoreBusClientOptions {
	/** Global store carrying the bus snapshot (default globalThis). */
	store?: Record<string, unknown>;
	adapters?: CoreBusAdapter[];
}

export function createCoreBusClient(options: CoreBusClientOptions = {}): CoreBusClient {
	const store = options.store ?? (globalThis as unknown as Record<string, unknown>);
	const adapters = [...(options.adapters ?? [])];
	// Adapter/subscription failures must never reach the host event path.
	const safe = (fn: () => void): void => {
		try {
			fn();
		} catch {
			/* contained per step */
		}
	};

	let generation = 0;
	let active = false;
	let unsubscribe: (() => void) | null = null;
	let attachedBusId: unknown = null;
	let presenceBusId: unknown;
	let presenceMaxNotifyId = 0;
	let obsBaselineKeys: ReadonlySet<string> = new Set();
	let presenceObject: Record<string, unknown> | null = null;

	const declarePresence = (): void => {
		// The capability shape core negotiates on (ui/notify.ts + fallback):
		// active + notificationsConsumer stop core's direct forward and its
		// fallback display; the queue is ours to consume. The object itself
		// is the ownership token — close() withdraws it only while it is
		// still OURS on the store.
		presenceObject = { version: 1, active: true, notificationsConsumer: true };
		store[PRESENCE_KEY] = presenceObject;
		store[LEGACY_PRESENCE_KEY] = true;
	};

	const detach = (): void => {
		generation++;
		const stop = unsubscribe;
		unsubscribe = null;
		attachedBusId = null;
		if (stop) safe(stop);
		for (const adapter of adapters) safe(() => adapter.onDetach?.());
	};

	const client: CoreBusClient = {
		activate(): void {
			if (active) return;
			active = true;
			// Handoff baseline — captured at PRESENCE DECLARATION, never
			// re-truncated by later activates (C9).
			const snapshot = snapshotOf(store);
			presenceBusId = busIdentityOf(snapshot);
			presenceMaxNotifyId = maxNotificationIdOf(snapshot);
			obsBaselineKeys = new Set(obsSitesOf(snapshot).map(obsSiteKey));
			declarePresence();
			client.retry();
		},

		retry(): boolean {
			if (!active) return false;
			const snapshot = snapshotOf(store);
			const id = busIdentityOf(snapshot);
			if (id === null || !snapshot) return false; // v1 / no bus yet — a later retry point re-attempts
			if (unsubscribe && id === attachedBusId) return true; // fast path: attached & unchanged
			if (unsubscribe) detach(); // bus replaced: invalidate the old generation first
			const register = snapshot.onChange;
			if (typeof register !== "function") return false;
			const gen = ++generation;
			const listener = (): void => {
				// Late callbacks from an older bus/generation deliver nothing
				// and must never read a snapshot belonging to a new session.
				if (gen !== generation || !active) return;
				const live = snapshotOf(store);
				if (!live || busIdentityOf(live) !== attachedBusId) {
					client.retry(); // the bus under us changed — re-resolve
					return;
				}
				for (const adapter of adapters) safe(() => adapter.onSnapshot?.(live));
			};
			attachedBusId = id;
			// Subscribe failures must never reach the host (P0-2 §4.1): stay
			// detached, invalidate the generation, remain retryable.
			try {
				unsubscribe = register(listener);
			} catch {
				unsubscribe = null;
				attachedBusId = null;
				generation++;
				return false;
			}
			// onChange does NOT replay the current state — consume it now so
			// the handoff window (presence → attach) is not lost to the next
			// unrelated publish.
			const handoff: CoreBusHandoff = {
				busId: attachedBusId,
				sameBusAsPresence: presenceBusId !== undefined && presenceBusId !== null && id === presenceBusId,
				presenceMaxNotifyId,
				obsBaselineKeys,
			};
			for (const adapter of adapters) safe(() => adapter.onAttach?.(snapshot, handoff));
			return true;
		},

		close(): void {
			if (!active && !unsubscribe && !presenceObject) return; // idempotent
			active = false;
			detach(); // generation++ → every late callback is now inert
			if (presenceObject !== null && store[PRESENCE_KEY] === presenceObject) {
				delete store[PRESENCE_KEY];
				delete store[LEGACY_PRESENCE_KEY];
			}
			presenceObject = null;
			presenceBusId = undefined;
			presenceMaxNotifyId = 0;
			obsBaselineKeys = new Set();
		},
	};
	return client;
}

// ---- display.footer channel (B6) -------------------------------------------

export interface CoreFooterChannel {
	adapter: CoreBusAdapter;
	/** Validated footer lines from the current bus (empty when absent). */
	lines(): string[];
}

/**
 * Read-only cache of the core-published `display.footer` rows (economy
 * module downgrade notes). Non-string entries are filtered; a detach or a
 * new bus without the field CLEARS the cache — stale text from an old bus
 * must never render. Content changes trigger the injected render request
 * (event-driven; never a timer).
 */
export function createFooterChannel(requestRender: () => void): CoreFooterChannel {
	let lines: string[] = [];
	const update = (raw: unknown): void => {
		const next = Array.isArray(raw)
			? raw.filter((line): line is string => typeof line === "string" && line.length > 0)
			: [];
		if (next.length === lines.length && next.every((line, i) => line === lines[i])) return;
		lines = next;
		safeRender();
	};
	const safeRender = (): void => {
		try {
			requestRender();
		} catch {
			/* render requests must never throw into the bus path */
		}
	};
	return {
		adapter: {
			onAttach(snapshot) {
				update(snapshot.display?.footer);
			},
			onSnapshot(snapshot) {
				update(snapshot.display?.footer);
			},
			onDetach() {
				if (lines.length > 0) {
					lines = [];
					safeRender();
				}
			},
		},
		lines: () => lines,
	};
}
