/**
 * SP2 (docs/STATUSLINE-PERF-PLAN.md §2/§3.3): zero-fork StatuslineSource for
 * the DEFAULT statusline command. Where the spawn path serializes the
 * CC-shaped JSON, forks `bash -c <script>` (bash + jq + git chain) and reads
 * its stdout back, this path feeds the same JSON straight to the pure
 * renderer (statusline-renderer.ts, SP1 parity-pinned byte-for-byte against
 * the script) and asks the git-segment-provider for the one datum the
 * parent does not own.
 *
 * Refresh flow mirrors the runner's lifecycle shape: request() renders a
 * frame immediately from the cached git segment, pokes the provider (TTL'd
 * dirty spawn / watcher-driven branch re-read), and a landed segment fires
 * onUpdate → the session re-renders a frame later — the same "settles
 * async" contract the footer already handles for slow child scripts.
 *
 * hasPersistentError() is always false: there is no child to fail; a parse
 * hiccup keeps the last good lines (fail-open, like the runner keeping its
 * last output through a failing run).
 */

import { renderDefaultStatusline } from "./statusline-renderer.ts";
import { createGitSegmentProvider, type GitSegmentProvider } from "./git-segment-provider.ts";
import type { StatuslineSource } from "./statusline.ts";

export interface InProcessStatuslineOptions {
	/** Working directory for the dir/git segments (default: process.cwd()). */
	cwd?: string;
	/** HOME for the ~/ prefix substitution (default: process.env.HOME; tests pin it). */
	home?: string;
	/** Git segment source (tests inject; default: real provider with 10s dirty TTL). */
	gitProvider?: GitSegmentProvider;
}

export class InProcessStatusline implements StatuslineSource {
	private lines: string[] = [];
	private lastInput = "";
	private lastWidth = 100;
	private onUpdate: (() => void) | null = null;
	private readonly home: string | undefined;
	private readonly cwd: string;
	private readonly git: GitSegmentProvider;

	constructor(options: InProcessStatuslineOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.home = options.home;
		this.git =
			options.gitProvider ??
			createGitSegmentProvider({
				onSegmentChange: () => {
					this.rerender();
					this.onUpdate?.();
				},
			});
	}

	request(input: string, width: number): void {
		this.lastInput = input;
		this.lastWidth = width;
		this.git.poke(this.cwd);
		this.rerender();
		this.onUpdate?.();
	}

	getRenderLines(): string[] {
		return this.lines;
	}

	hasPersistentError(): boolean {
		return false;
	}

	setOnUpdate(callback: (() => void) | null): void {
		this.onUpdate = callback;
	}

	dispose(): void {
		this.git.dispose();
	}

	private rerender(): void {
		if (this.lastInput === "") return;
		try {
			const line = renderDefaultStatusline(JSON.parse(this.lastInput), this.lastWidth, {
				cwd: this.cwd,
				home: this.home,
				git: this.git.segment(this.cwd),
			});
			this.lines = [line];
		} catch {
			// keep the last good lines — fail-open
		}
	}
}
