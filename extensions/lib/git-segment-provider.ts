/**
 * SP2 (docs/STATUSLINE-PERF-PLAN.md §3.2): git segment for the in-process
 * statusline, modeled on Claude Code's gitFilesystem.ts (user-directed
 * design reference) but cut down to what a status line needs.
 *
 * Two layers, per the plan's D2 split:
 * - branch: ZERO fork. The branch NAME is the only thing display needs, and
 *   it lives in `.git/HEAD` (`ref: refs/heads/<name>` / detached sha). CC
 *   also resolves ref SHAs and remote URLs, which forces packed-refs parsing
 *   and branch-ref watching; we cache the name only, so those drop out.
 *   Invalidation points: HEAD (checkout / rebase / detach / new branch all
 *   rewrite it) plus the current branch's ref file — the ref APPEARS on an
 *   unborn branch's first commit while HEAD stays byte-identical, so the
 *   ref watcher is what covers unborn → born (why CC also watches it).
 *   Worktrees are handled by resolving the `gitdir:` pointer when `.git` is
 *   a file (gitbutler layout included; the pointer may contain spaces).
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
 * Watchers use fs.watchFile (stat polling, CC's choice) with
 * persistent: false — they never hold the host's event loop open — and work
 * on files that do not exist yet (unborn branch refs). Everything unwatched
 * in dispose(); a spawn that lands after dispose never re-notifies (entry
 * liveness guard), so disposed providers cannot resurrect watchers.
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
	commonDir: string;
	cwd: string;
	branch: string | null;
	dirty: number;
	dirtyAt: number;
	/** .git/index mtime moved since the last spawn → spawn on next poke even inside the TTL. */
	dirtyStale: boolean;
	inFlight: boolean;
	watchedHeadPath: string;
	watchedIndexPath: string;
	watchedRefPath: string | null;
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
				const match = /^gitdir:\s*(.+)$/m.exec(body);
				if (match) return resolve(current, match[1]!.trim());
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

/**
 * The dir holding shared refs/packed-refs for this checkout: plain repos
 * it's the gitDir itself; worktrees keep theirs in the common dir (the
 * `commondir` file when present, else the worktree gitdir's grandparent).
 */
export function resolveCommonDir(gitDir: string): string {
	try {
		const body = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		if (body !== "") return resolve(gitDir, body);
	} catch {
		// no commondir file → plain repo or older worktree layout
	}
	const worktreeMatch = /(?:^|\/)(?:\.git|git)\/worktrees\/[^/]+\/?$/.exec(gitDir);
	return worktreeMatch ? resolve(gitDir, "../..") : gitDir;
}

/** True when the branch ref exists at all (loose file or packed-refs line). */
function refExists(commonDir: string, branch: string): boolean {
	const refPath = join(commonDir, "refs", "heads", ...branch.split("/"));
	try {
		statSync(refPath);
		return true;
	} catch {
		// fall through to packed-refs
	}
	try {
		const packed = readFileSync(join(commonDir, "packed-refs"), "utf8");
		return new RegExp(`^#?[0-9a-f]{40} refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(packed);
	} catch {
		return false;
	}
}

function readHeadBranch(gitDir: string, commonDir: string): string | null {
	try {
		const body = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		if (body.startsWith("ref:")) {
			const ref = body.slice(4).trim();
			const prefix = "refs/heads/";
			// a foreign symref (manual `git symbolic-ref` to something outside
			// refs/heads) renders as detached in `git status -b` — match it
			// (review n1) and skip the meaningless ref watch
			if (!ref.startsWith(prefix)) return DETACHED_BRANCH_DISPLAY;
			const name = ref.slice(prefix.length);
			// unborn branch (fresh `git init`): `git status -b` renders
			// "No commits yet on <name>" — byte parity demands we match it
			return refExists(commonDir, name) ? name : `No commits yet on ${name}`;
		}
		return DETACHED_BRANCH_DISPLAY;
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
		const commonDir = resolveCommonDir(gitDir);
		const entry: RepoEntry = {
			gitDir,
			commonDir,
			cwd: key,
			branch: readHeadBranch(gitDir, commonDir),
			dirty: 0,
			dirtyAt: 0,
			dirtyStale: true, // cold → first poke spawns immediately
			inFlight: false,
			watchedHeadPath: join(gitDir, "HEAD"),
			// worktrees keep their index inside the worktree gitDir; plain
			// repos keep it in .git — join(gitDir, "index") is correct for both
			watchedIndexPath: join(gitDir, "index"),
			watchedRefPath: null,
			headMtimeMs: null,
		};
		entry.headMtimeMs = mtimeOf(entry.watchedHeadPath);
		entries.set(key, entry);
		watchEntry(entry);
		return entry;
	};

	const watchBranchRef = (entry: RepoEntry, branch: string | null): void => {
		// Unwatch the previous branch's ref (branch switch / → detached).
		if (entry.watchedRefPath) {
			unwatchFile(entry.watchedRefPath);
			entry.watchedRefPath = null;
		}
		if (!branch || branch === DETACHED_BRANCH_DISPLAY) {
			// detached (or foreign symref mapped to the detached display,
			// review n1 second half): no meaningful branch ref to watch —
			// skip instead of arming a watcher on a garbage path
			return;
		}
		// "No commits yet on X" carries the real name after the prefix; the
		// watcher also serves born branches (ref writes re-read harmlessly).
		const name = branch.startsWith("No commits yet on ") ? branch.slice("No commits yet on ".length) : branch;
		const refPath = join(entry.commonDir, "refs", "heads", ...name.split("/"));
		entry.watchedRefPath = refPath;
		// watchFile works on nonexistent files — it fires when the file
		// APPEARS, which is exactly the unborn → born transition (first
		// commit writes the ref while HEAD's content stays unchanged).
		watchFile(refPath, { interval: watchIntervalMs, persistent: false }, () => {
			const next = readHeadBranch(entry.gitDir, entry.commonDir);
			if (next !== entry.branch) {
				entry.branch = next;
				deps.onSegmentChange?.(entry.cwd);
			}
		});
	};

	const watchEntry = (entry: RepoEntry): void => {
		watchFile(entry.watchedHeadPath, { interval: watchIntervalMs, persistent: false }, (cur) => {
			const mtime = cur.mtimeMs;
			if (mtime === entry.headMtimeMs) return;
			entry.headMtimeMs = mtime;
			// checkout / rebase / detach — re-read the name synchronously and
			// re-mount the branch-ref watcher for the new branch
			const next = readHeadBranch(entry.gitDir, entry.commonDir);
			if (next !== entry.branch) {
				entry.branch = next;
				watchBranchRef(entry, next);
				deps.onSegmentChange?.(entry.cwd);
			} else {
				watchBranchRef(entry, next);
			}
		});
		watchFile(entry.watchedIndexPath, { interval: watchIntervalMs, persistent: false }, () => {
			// watchFile only fires on an actual stat change; over-marking is
			// impossible, and a stale flag costs at most one spawn at the next poke
			entry.dirtyStale = true;
		});
		watchBranchRef(entry, entry.branch);
	};

	const launchDirty = (entry: RepoEntry): void => {
		entry.inFlight = true;
		entry.dirtyStale = false;
		const prevDirty = entry.dirty;
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
				// Review M1: a dispose() mid-flight clears `entries` and unwatches;
				// firing onSegmentChange now would rerender → segment() →
				// bootstrap() → REMOUNT watchers on a disposed provider. Guard:
				// only notify while this exact entry is still live.
				if (entries.get(entry.cwd) !== entry) return;
				if (entry.dirty !== prevDirty) deps.onSegmentChange?.(entry.cwd);
			});
	};

	let providerDisposed = false;

	return {
		segment(cwd: string): StatuslineGitSegment | null {
			// defense in depth (review follow-up): a stray post-dispose call
			// must not bootstrap() a fresh entry and remount watchers
			if (providerDisposed) return null;
			const entry = bootstrap(cwd);
			if (!entry || entry.branch === null) return null;
			return { branch: entry.branch, dirty: entry.dirty };
		},
		poke(cwd: string): void {
			if (providerDisposed) return;
			const entry = bootstrap(cwd);
			if (!entry) return;
			const expired = now() - entry.dirtyAt >= ttlMs;
			if (entry.inFlight) return;
			if (expired || entry.dirtyStale) launchDirty(entry);
		},
		dispose(): void {
			providerDisposed = true;
			for (const entry of entries.values()) {
				unwatchFile(entry.watchedHeadPath);
				unwatchFile(entry.watchedIndexPath);
				if (entry.watchedRefPath) unwatchFile(entry.watchedRefPath);
			}
			entries.clear();
		},
	};
}
