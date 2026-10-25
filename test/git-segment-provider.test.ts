/**
 * SP2 (docs/STATUSLINE-PERF-PLAN.md §3.2): git-segment-provider tests.
 * Branch layer against real git fixtures (plain repo / worktree / detached /
 * gitless), dirty layer with an injected spawn probe and a fake clock
 * (TTL window, in-flight dedup, error backoff), plus the two watchers
 * (HEAD switch, .git/index early invalidation) at a 20ms poll interval.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	branchFromHead,
	countDirty,
	createGitSegmentProvider,
	DETACHED_BRANCH_DISPLAY,
} from "../extensions/lib/git-segment-provider.ts";

// ---------------------------------------------------------------------------
// Pure parsers

test("countDirty: ## header excluded, untracked/modified/staged all count", () => {
	assert.equal(countDirty("## main...origin/main [ahead 1]\n M a\n?? b\nA  c\n"), 3);
	assert.equal(countDirty("## main\n"), 0);
	assert.equal(countDirty(""), 0);
});

test("branchFromHead: ref line strips refs/heads/, sha → detached display, foreign ref kept raw", () => {
	assert.equal(branchFromHead("ref: refs/heads/main\n"), "main");
	assert.equal(branchFromHead("ref: refs/heads/feature/x\n"), "feature/x");
	assert.equal(branchFromHead("0123456789abcdef0123456789abcdef01234567\n"), DETACHED_BRANCH_DISPLAY);
	assert.equal(branchFromHead("ref: refs/other\n"), "refs/other");
});

// ---------------------------------------------------------------------------
// Fixtures

let root: string;
test.before(() => {
	root = mkdtempSync(join(tmpdir(), "sl-gitseg-"));
});
test.after(() => {
	rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@t.local", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
}

function makeRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "one\n");
	git(dir, "add", "a.txt");
	git(dir, "commit", "-m", "init");
	return dir;
}

// ---------------------------------------------------------------------------
// Branch layer (fs, zero fork)

test("segment: plain repo branch from HEAD, dirty 0 until first spawn lands", () => {
	const repo = makeRepo("plain");
	const p = createGitSegmentProvider({ spawnGit: () => Promise.resolve("## main\n") });
	try {
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 0 });
		p.poke(repo);
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 0 }, "spawn is async — dirty lands later");
	} finally {
		p.dispose();
	}
});

test("segment: detached HEAD maps to the git status display string", () => {
	const repo = makeRepo("detached");
	git(repo, "checkout", "--detach");
	const p = createGitSegmentProvider({ spawnGit: () => Promise.resolve("## HEAD (no branch)\n") });
	try {
		assert.deepEqual(p.segment(repo), { branch: DETACHED_BRANCH_DISPLAY, dirty: 0 });
	} finally {
		p.dispose();
	}
});

test("segment: worktree (.git as a file with gitdir pointer) resolves like git status", () => {
	const repo = makeRepo("wt-main");
	git(repo, "worktree", "add", join(root, "wt-linked"), "-b", "wt-branch");
	const p = createGitSegmentProvider({ spawnGit: () => Promise.resolve("## wt-branch\n") });
	try {
		assert.deepEqual(p.segment(join(root, "wt-linked")), { branch: "wt-branch", dirty: 0 });
	} finally {
		p.dispose();
	}
});

test("segment: non-repo → null and poke spawns nothing", () => {
	const dir = join(root, "no-repo");
	mkdirSync(dir, { recursive: true });
	let spawns = 0;
	const p = createGitSegmentProvider({ spawnGit: () => { spawns += 1; return Promise.resolve(""); } });
	try {
		assert.equal(p.segment(dir), null);
		p.poke(dir);
		p.poke(dir);
		assert.equal(spawns, 0);
	} finally {
		p.dispose();
	}
});

test("HEAD watcher: branch switch re-reads and fires onSegmentChange", async () => {
	const repo = makeRepo("watch-head");
	const changed: string[] = [];
	const p = createGitSegmentProvider({
		watchIntervalMs: 20,
		spawnGit: () => Promise.resolve("## main\n"),
		onSegmentChange: (cwd) => changed.push(cwd),
	});
	try {
		assert.equal(p.segment(repo)?.branch, "main");
		git(repo, "checkout", "-b", "switched");
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(p.segment(repo)?.branch, "switched", "watcher picked the new HEAD");
		assert.ok(changed.length >= 1, "onSegmentChange fired");
	} finally {
		p.dispose();
	}
});

// ---------------------------------------------------------------------------
// Dirty layer (TTL / dedup / error backoff)

test("dirty: first poke spawns (cold), TTL window holds, expiry respawns", async () => {
	const repo = makeRepo("ttl");
	let t = 1_000;
	const calls: string[] = [];
	const p = createGitSegmentProvider({
		now: () => t,
		ttlMs: 10_000,
		spawnGit: async (cwd) => {
			calls.push(cwd);
			return "## main\n M a\n?? b\n";
		},
	});
	try {
		p.poke(repo);
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(calls.length, 1);
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 2 }, "dirty landed");
		p.poke(repo);
		p.poke(repo);
		assert.equal(calls.length, 1, "inside the TTL window: no respawn");
		t += 10_001;
		p.poke(repo);
		assert.equal(calls.length, 2, "expired: respawn");
	} finally {
		p.dispose();
	}
});

test("dirty: in-flight poke dedups to a single spawn", async () => {
	const repo = makeRepo("inflight");
	let resolveSpawn: (out: string) => void = () => {};
	let spawns = 0;
	const p = createGitSegmentProvider({
		spawnGit: () => {
			spawns += 1;
			return new Promise<string>((res) => { resolveSpawn = res; });
		},
	});
	try {
		p.poke(repo);
		p.poke(repo);
		p.poke(repo);
		assert.equal(spawns, 1);
		resolveSpawn("## main\n M a\n");
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 1 });
	} finally {
		p.dispose();
	}
});

test("dirty: spawn failure is silent, keeps the last value, backs off to the next TTL window", async () => {
	const repo = makeRepo("err");
	let t = 1_000;
	let fail = true;
	let spawns = 0;
	const p = createGitSegmentProvider({
		now: () => t,
		ttlMs: 10_000,
		spawnGit: async () => {
			spawns += 1;
			if (fail) throw new Error("git missing");
			return "## main\n M a\n";
		},
	});
	try {
		p.poke(repo);
		await new Promise((r) => setTimeout(r, 0));
		p.poke(repo);
		assert.equal(spawns, 1, "failure set dirtyAt → no hot retry");
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 0 }, "last dirty value kept");
		t += 10_001;
		fail = false;
		p.poke(repo);
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 1 }, "recovers next window");
	} finally {
		p.dispose();
	}
});

test("index watcher: tracked edit early-invalidates the TTL window", async () => {
	const repo = makeRepo("watch-index");
	let t = 1_000;
	let spawns = 0;
	let dirtyOut = "## main\n";
	const p = createGitSegmentProvider({
		now: () => t,
		ttlMs: 60_000, // TTL effectively never expires in this test
		watchIntervalMs: 20,
		spawnGit: async () => {
			spawns += 1;
			return dirtyOut;
		},
	});
	try {
		p.poke(repo); // cold spawn
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(spawns, 1);
		p.poke(repo);
		assert.equal(spawns, 1, "TTL holds while the index is untouched");
		// tracked edit → git add rewrites .git/index → watcher marks stale
		writeFileSync(join(repo, "a.txt"), "one!\n");
		git(repo, "add", "a.txt");
		dirtyOut = "## main\nM  a.txt\n";
		await new Promise((r) => setTimeout(r, 150));
		p.poke(repo);
		assert.equal(spawns, 2, "index mtime moved → early refresh without TTL expiry");
		await new Promise((r) => setTimeout(r, 0));
		assert.deepEqual(p.segment(repo), { branch: "main", dirty: 1 });
	} finally {
		p.dispose();
	}
});
