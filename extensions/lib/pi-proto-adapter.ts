/**
 * Prototype-method adapter for pi's own components (spec 8.3).
 *
 * The remaining prototype patches (compaction row, skill row, user-message
 * bar) target pi classes, not subagent surfaces. They share lifecycle rules
 * this module centralizes:
 *
 * - Original-method saving and ownership: restore() withdraws only the
 *   rewrite that is still ours — if another extension replaced the method
 *   after us, we leave it alone.
 * - Repeated installs refresh the current theme getter: the marker value is
 *   a refresh function owned by the installing instance, so a later
 *   apply() (re-enable, reload with a second module instance) updates the
 *   live getter instead of returning early on the marker and reading a
 *   dead closure forever.
 * - Host shape checks run per call; a mismatch (pi changed internals)
 *   degrades to the saved original.
 * - The replacement never throws: render paths are uncatchable upstream, so
 *   any failure falls back to the original method (or a no-op when there is
 *   none), never a crash.
 */

export type ThemeFg = (color: string, text: string) => string;

export interface PrototypeMethodAdapterOptions {
	/** The prototype carrying the method (e.g. SomeComponent.prototype). */
	proto: object;
	/** The method name being replaced (e.g. "updateDisplay"). */
	method: string;
	/** Marker key; presence means "CC-TUI patched this". */
	marker: string;
	/** False when the host lacks the fields the CC body needs (pi changed). */
	hostMatches: (host: unknown) => boolean;
	/** The CC rendering body. Replacement-style bodies reimplement fully;
	 * wrapper-style bodies call `original` first (user-message bar). The
	 * saved original is undefined when the host had no such method. */
	body: (host: Record<string, unknown>, fg: ThemeFg, original: (() => void) | undefined) => void;
}

export class PrototypeMethodAdapter {
	private readonly options: PrototypeMethodAdapterOptions;
	private currentFg: (() => ThemeFg | null) | null = null;
	private wrapper: ((this: never) => void) | undefined;
	private original: (() => void) | undefined;

	constructor(options: PrototypeMethodAdapterOptions) {
		this.options = options;
	}

	/** Install (first call) or refresh the getter (every call). Never throws. */
	apply(getFg: () => ThemeFg | null): void {
		this.currentFg = getFg;
		const proto = this.options.proto as unknown as Record<string, unknown>;
		try {
			const incumbent = proto[this.options.marker];
			if (typeof incumbent === "function") {
				// A previous instance (or an earlier apply) owns the rewrite:
				// refresh ITS getter — the marker must never freeze a closure.
				(incumbent as (getFg: () => ThemeFg | null) => void)(getFg);
				return;
			}
			if (incumbent !== undefined && incumbent !== false) return; // foreign marker value: stay off
			const original = proto[this.options.method];
			this.original = typeof original === "function" ? (original as () => void) : undefined;
			const adapter = this;
			const wrapper = function (this: unknown): void {
				const fg = (color: string, text: string): string => {
				const paint = adapter.currentFg !== null ? adapter.currentFg() : null;
				return paint !== null && paint !== undefined ? paint(color, text) : text;
			};
				try {
					if (!adapter.options.hostMatches(this)) throw new Error("host shape mismatch");
					adapter.options.body(this as Record<string, unknown>, fg, adapter.original);
				} catch {
					// Degrade, never throw inside a render path.
					adapter.original?.call(this);
				}
			} as (this: never) => void;
			this.wrapper = wrapper;
			proto[this.options.method] = wrapper;
			proto[this.options.marker] = (next: () => ThemeFg | null) => {
				adapter.currentFg = next;
			};
		} catch {
			// Install-time failures leave the stock method untouched.
		}
	}

	/**
	 * Withdraw the rewrite if — and only if — our wrapper is still the
	 * installed method. A later taker's replacement stays; a fresh apply()
	 * reinstalls cleanly.
	 */
	restore(): void {
		try {
			const proto = this.options.proto as unknown as Record<string, unknown>;
			if (this.wrapper !== undefined && proto[this.options.method] === this.wrapper) {
				if (this.original !== undefined) proto[this.options.method] = this.original;
				else delete proto[this.options.method];
				delete proto[this.options.marker];
			}
		} catch {
			// Restore failures must not break disable/shutdown.
		} finally {
			this.wrapper = undefined;
			this.original = undefined;
			this.currentFg = null;
		}
	}
}
