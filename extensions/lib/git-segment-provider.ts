/**
 * SP2 (docs/STATUSLINE-PERF-PLAN.md §3.2): git segment for the in-process
 * statusline, modeled on Claude Code's gitFilesystem.ts (user-directed
 * design reference) but cut down to what a status line needs.
 *
 * Two layers, per the plan's D2 split:
 * - branch: ZERO fork. The branch NAME is the only thing display needs, and
 *   it lives in `.git/HEAD` (`ref: refs/heads/<name>` / detached sha). CC
 *   also resolves ref SHAs and remote URLs, which forces packed-refs parsing
 *   and branch-ref watching; we cache the name only, so those drop out and
 *   HEAD is the single invalidation point (checkout / rebase / detach / new
 *   branch all rewrite it). Worktrees are handled by resolving the `gitdir:`
 *   pointer when `.git` is a file (gitbutler layout included).
 * - dirty count: ONE async `git status -b --porcelain` per TTL window
 *   (default 10s), dedup'd in flight, with `.git/index` mtime watching as
 *   EARLY invalidation (tracked edits/stages recompute immediately;
 *   untracked-only additions never touch the index, so the TTL is the
 *   staleness ceiling for exactly that case — the plan's documented
 *   user-visible semantic).
 *
 * Deviations from CC, on purpose: reads are SYNC (files are tiny; the
 * async-compute race discipline CC carries exists because its compute is
 * async — with sync reads there is no window), and a failed spawn backs off
 * to the next TTL window instead of retrying every poke (silent, keeps the
 * last dirty value, matching the bash script's `2>/dev/null` behavior).
 *
 * Watchers use fs.watchFile (stat polling, CC's choice): it works on files
 * that do not exist yet and never needs FSEvents edge-case handling.
 * Everything unwatched in dispose(); never holds the event loop.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync, watchFile, unwatchFile, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StatuslineGitSegment } from "./statusline-renderer.ts";

export interface GitSegmentProvider {
	/** Cached segment for cwd: branch from HEAD + last dirty count. Non-repo → null. */
	segment(cwd: string): StatuslineGitSegment | null;
	/** Called on every statusline refresh: kick branch re-read (watcher-driven, free) and a TTL'd dirty spawn. */
	poke(cwd: string): void;
	/** Stop all watchers. Idempotent. */
	dispose(): void;
}

export interface GitSegmentProviderDeps {
	now?: () => number;
	/** Dirty-count spawn floor in ms (default 10s). */
	ttlMs?: number;
	/** Stat polling interval for HEAD/.git/index watchers (default 1s; tests pass 10-50). */
	watchIntervalMs?: number;
	/** Git dirty probe, injectable. Default: git status -b --porcelain, 2s timeout. */
	spawnGit?: (cwd: string) => Promise<string>;
	/** Fired when the cached segment changed (dirty landed / branch switched) → host re-renders. */
	onSegmentChange?: (cwd: string) => void;
}

/** Display string parity with `git status -b --porcelain` on a detached HEAD. */
export const DETACHED_BRANCH_DISPLAY = "HEAD (no branch)";

interface RepoEntry {
	gitDir: string;
	cwd: string;
	branch: string | null;
	dirty: number;
	dirtyAt: number;
	/** .git/index mtime moved since the last spawn → spawn on next poke even inside the TTL. */
	dirtyStale: boolean;
	inFlight: boolean;
	watchedHeadPath: string;
	watchedIndexPath: string;
	headMtimeMs: number | null;
}

const defaultSpawnGit = (cwd: string): Promise<string> =>
	new Promise<string>((resolvePromise, reject) => {
		execFile(
			"git",
			["--no-optional-locks", "status", "-b", "--porcelain"],
			{ cwd, timeout: 2000, maxBuffer: 1024 * 1024 },
			(err, stdout) => (err ? reject(err) : resolvePromise(stdout as string)),
		);
	});

/** Parse a `git status -b --porcelain` body into a dirty count (## header excluded). */
export function countDirty(statusOut: string): number {
	let dirty = 0;
	for (const line of statusOut.split("\n")) {
		if (line === "" || line.startsWith("## ")) continue;
		dirty += 1;
	}
	return dirty;
}

/** Branch display name from a .git/HEAD body ("ref: refs/heads/x" → x, sha → detached). */
export function branchFromHead(headBody: string): string | null {
	const trimmed = headBody.trim();
	if (trimmed.startsWith("ref:")) {
		const ref = trimmed.slice(4).trim();
		const prefix = "refs/heads/";
		return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
	}
	return DETACHED_BRANCH_DISPLAY;
}

/**
 * Walk up from cwd for `.git` — a directory (plain repo) or a FILE whose
 * `gitdir: <path>` line points at the real git dir (worktree / gitbutler).
 * Null at filesystem root.
 */
export function resolveGitDir(cwd: string): string | null {
	let current = resolve(cwd);
	for (;;) {
		const dotGit = join(current, ".git");
		let st: Stats | undefined;
		try {
			st = statSync(dotGit);
		} catch {
			st = undefined;
		}
		if (st?.isDirectory()) return dotGit;
		if (st?.isFile()) {
			try {
				const body = readFileSync(dotGit, "utf8").trim();
				const match = /^gitdir:\s*(\S+)$/m.exec(body);
				if (match) return resolve(current, match[1]!);
			} catch {
				// unreadable pointer → treat as non-repo
			}
			return null;
		}
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function readHeadBranch(gitDir: string): string | null {
	try {
		return branchFromHead(readFileSync(join(gitDir, "HEAD"), "utf8"));
	} catch {
		return null;
	}
}

function mtimeOf(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

export function createGitSegmentProvider(deps: GitSegmentProviderDeps = {}): GitSegmentProvider {
	const now = deps.now ?? Date.now;
	const ttlMs = deps.ttlMs ?? 10_000;
	const watchIntervalMs = deps.watchIntervalMs ?? 1_000;
	const spawnGit = deps.spawnGit ?? defaultSpawnGit;
	const entries = new Map<string, RepoEntry>();

	const bootstrap = (cwd: string): RepoEntry | null => {
		const key = resolve(cwd);
		const existing = entries.get(key);
		if (existing) return existing;
		const gitDir = resolveGitDir(key);
		if (!gitDir) return null;
		const entry: RepoEntry = {
			gitDir,
			cwd: key,
			branch: readHeadBranch(gitDir),
			dirty: 0,
			dirtyAt: 0,
			dirtyStale: true, // cold → first poke spawns immediately
			inFlight: false,
			watchedHeadPath: join(gitDir, "HEAD"),
			// worktrees keep their index inside the worktree gitDir; plain
			// repos keep it in .git — join(gitDir, "index") is correct for both
			watchedIndexPath: join(gitDir, "index"),
			headMtimeMs: null,
		};
		entry.headMtimeMs = mtimeOf(entry.watchedHeadPath);
		entries.set(key, entry);
		watchEntry(entry);
		return entry;
	};

	const watchEntry = (entry: RepoEntry): void => {
		watchFile(entry.watchedHeadPath, { interval: watchIntervalMs }, (cur) => {
			const mtime = cur.mtimeMs;
			if (mtime === entry.headMtimeMs) return;
			entry.headMtimeMs = mtime;
			// checkout / rebase / detach — re-read the name synchronously
			const next = readHeadBranch(entry.gitDir);
			if (next !== entry.branch) {
				entry.branch = next;
				deps.onSegmentChange?.(entry.cwd);
			}
		});
		watchFile(entry.watchedIndexPath, { interval: watchIntervalMs }, () => {
			// watchFile only fires on an actual stat change; over-marking is
			// impossible, and a stale flag costs at most one spawn at the next poke
			entry.dirtyStale = true;
		});
	};

	const launchDirty = (entry: RepoEntry): void => {
		entry.inFlight = true;
		entry.dirtyStale = false;
		Promise.resolve(spawnGit(entry.cwd))
			.then((out) => {
				entry.dirty = countDirty(out);
			})
			.catch(() => {
				// silent: keep the last dirty value (bash 2>/dev/null parity);
				// backing off via dirtyAt below prevents a hot retry loop
			})
			.finally(() => {
				entry.inFlight = false;
				entry.dirtyAt = now();
				deps.onSegmentChange?.(entry.cwd);
			});
	};

	return {
		segment(cwd: string): StatuslineGitSegment | null {
			const entry = bootstrap(cwd);
			if (!entry || entry.branch === null) return null;
			return { branch: entry.branch, dirty: entry.dirty };
		},
		poke(cwd: string): void {
			const entry = bootstrap(cwd);
			if (!entry) return;
			const expired = now() - entry.dirtyAt >= ttlMs;
			if (entry.inFlight) return;
			if (expired || entry.dirtyStale) launchDirty(entry);
		},
		dispose(): void {
			for (const entry of entries.values()) {
				unwatchFile(entry.watchedHeadPath);
				unwatchFile(entry.watchedIndexPath);
			}
			entries.clear();
		},
	};
}
