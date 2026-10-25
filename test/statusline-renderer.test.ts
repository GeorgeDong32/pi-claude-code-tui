/**
 * SP1 (docs/STATUSLINE-PERF-PLAN.md §4): parity golden matrix — the pure
 * renderer (extensions/lib/statusline-renderer.ts) must be byte-identical
 * to `bash -c DEFAULT_STATUSLINE_SCRIPT` fed the same JSON doc, width, cwd
 * and git state. Together with the existing embedded-vs-.sh byte test this
 * closes the three-way parity triangle (TS renderer / embedded script /
 * scripts/statusline-default.sh).
 *
 * The bash oracle runs for real (bash + jq + git fixtures in a temp dir),
 * mirroring how the StatuslineRunner invokes it. Parity cases are skipped
 * with a notice when jq is unavailable (CI containers); unit cases always
 * run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_STATUSLINE_SCRIPT } from "../extensions/lib/statusline-default-script.ts";
import {
	formatCost,
	formatTokens,
	jqAlt,
	renderDefaultStatusline,
	type StatuslineGitSegment,
} from "../extensions/lib/statusline-renderer.ts";

// ---------------------------------------------------------------------------
// Unit: number formatting and jq semantics

test("formatTokens: k/M boundaries match jq tok", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1k");
	assert.equal(formatTokens(1_500), "2k"); // jq round(1.5) = 2
	assert.equal(formatTokens(999_999), "1000k");
	assert.equal(formatTokens(1_000_000), "1M");
	assert.equal(formatTokens(2_500_000), "2.5M");
	assert.equal(formatTokens(2_550_000), "2.6M"); // 25.5 rounds away like jq
});

test("formatCost: cents above $0.01, raw below, $0 drops", () => {
	assert.equal(formatCost(0), "$0");
	assert.equal(formatCost(0.0072), "$0.0072");
	assert.equal(formatCost(0.009), "$0.009");
	assert.equal(formatCost(0.01), "$0.01");
	assert.equal(formatCost(0.042), "$0.04");
	assert.equal(formatCost(0.1), "$0.1");
	assert.equal(formatCost(1.5), "$1.5");
	assert.equal(formatCost(2), "$2");
});

test("jqAlt: alternative only for null/false/undefined — 0 and \"\" stay", () => {
	assert.equal(jqAlt(null, "?"), "?");
	assert.equal(jqAlt(false, "?"), "?");
	assert.equal(jqAlt(undefined, 0), 0);
	assert.equal(jqAlt(0, 5), 0); // jq truthy
	assert.equal(jqAlt("", "?"), ""); // jq truthy
});

// ---------------------------------------------------------------------------
// Parity oracle

const hasJq = (() => {
	try {
		execFileSync("bash", ["-c", "command -v jq >/dev/null"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

interface Fixture {
	root: string;
	gitless: string;
	repo: string;
	detached: string;
	fakeHome: string;
	homeProj: string;
}

let fixture: Fixture | null = null;

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.email=t@t.local", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
}

function setupFixtures(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "sl-parity-"));
	const gitless = join(root, "gitless");
	const repo = join(root, "repo");
	const detached = join(root, "detached");
	const fakeHome = join(root, "fakehome");
	const homeProj = join(fakeHome, "proj");
	for (const d of [gitless, repo, detached, homeProj]) mkdirSync(d, { recursive: true });

	// repo: main + one commit + 2 dirty (modified + untracked) → {main, 2}
	git(repo, "init", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "add", "a.txt");
	git(repo, "commit", "-m", "init");
	writeFileSync(join(repo, "a.txt"), "one!\n");
	writeFileSync(join(repo, "b.txt"), "untracked\n");

	// detached: same shape, then `checkout --detach` → "HEAD (no branch)"
	git(detached, "init", "-b", "main");
	writeFileSync(join(detached, "a.txt"), "one\n");
	git(detached, "add", "a.txt");
	git(detached, "commit", "-m", "init");
	writeFileSync(join(detached, "c.txt"), "untracked\n");
	git(detached, "checkout", "--detach");

	return { root, gitless, repo, detached, fakeHome, homeProj };
}

test.before(() => {
	fixture = setupFixtures();
});
test.after(() => {
	if (fixture) rmSync(fixture.root, { recursive: true, force: true });
});

function runOracle(json: string, width: number, cwd: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"bash",
			["-c", DEFAULT_STATUSLINE_SCRIPT],
			{ cwd, env: { ...process.env, ...env, OVERRIDE_TERM_WIDTH: String(width) } },
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
		child.stdin?.end(json);
	});
}

interface ParityCase {
	name: string;
	input: unknown;
	width: number;
	cwd: string;
	git: StatuslineGitSegment | null;
	env?: NodeJS.ProcessEnv;
	home?: string;
}

const doc = (over: Record<string, unknown> = {}): unknown => ({
	model: { display_name: "GLM 5.3", id: "zai/glm-5.3" },
	workspace: { current_dir: "/tmp", project_dir: "/tmp" },
	context_window: {
		context_window_size: 1_000_000,
		current_usage: { input_tokens: 26_000, output_tokens: 400 },
		total_input_tokens: 28_000,
		total_output_tokens: 170,
		used_percentage: 3,
		remaining_percentage: 97,
	},
	pi: { cost_usd: 0.0072, effort: "high", provider: "zai" },
	...over,
});

async function checkParity(c: ParityCase): Promise<void> {
	assert.ok(fixture, "fixture missing");
	// bash's $PWD is the kernel-resolved path (/private/var/... on macOS);
	// production hands the renderer process.cwd(), which is resolved the
	// same way. Resolve here so both sides see identical dir text and fit
	// math — the unresolved mkdtemp string would diverge by the symlink.
	const cwd = realpathSync(c.cwd);
	const home = realpathSync(c.home ?? (c.env?.HOME as string | undefined) ?? process.env.HOME ?? "/");
	const json = JSON.stringify(c.input);
	const stdout = await runOracle(json, c.width, cwd, c.env ? { ...c.env, HOME: home } : {});
	const rendered = renderDefaultStatusline(c.input, c.width, { cwd, home, git: c.git });
	assert.equal(rendered + "\n", stdout, `parity mismatch for case "${c.name}"`);
}

const parityCases = (): ParityCase[] => {
	const f = fixture!;
	const main2: StatuslineGitSegment = { branch: "main", dirty: 2 };
	return [
		{ name: "wide full row, gitless", input: doc(), width: 140, cwd: f.gitless, git: null },
		{ name: "wide full row, git {main,2}", input: doc(), width: 140, cwd: f.repo, git: main2 },
		{ name: "detached HEAD shows literal branch string", input: doc(), width: 140, cwd: f.detached, git: { branch: "HEAD (no branch)", dirty: 1 } },
		{ name: "width 60 drops segments right-to-left", input: doc(), width: 60, cwd: f.repo, git: main2 },
		{ name: "width 30 keeps only what fits", input: doc(), width: 30, cwd: f.repo, git: main2 },
		{ name: "width 0 renders dir only", input: doc(), width: 0, cwd: f.repo, git: main2 },
		{ name: "cost 0 drops the cost segment", input: doc({ pi: { cost_usd: 0 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "cost 0.009 raw precision", input: doc({ pi: { cost_usd: 0.009 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "cost 0.01 cents boundary", input: doc({ pi: { cost_usd: 0.01 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "cost 0.042 rounds to cents", input: doc({ pi: { cost_usd: 0.042 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "cost 1.5 minimal cents", input: doc({ pi: { cost_usd: 1.5 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "tok boundaries 999/1k/1000k/1M/2.6M", input: doc({ context_window: { context_window_size: 2_550_000, used_percentage: 47 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "window 999 stays raw", input: doc({ context_window: { context_window_size: 999, used_percentage: 100 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "window 1_000_000 used 100%", input: doc({ context_window: { context_window_size: 1_000_000, used_percentage: 100 } }), width: 140, cwd: f.gitless, git: null },
		{ name: "missing model falls back to ?", input: doc({ model: {} }), width: 140, cwd: f.gitless, git: null },
		// NOTE: empty-string display_name is EXCLUDED from the oracle matrix on
		// purpose: bash `IFS=$'\t' read` collapses the LEADING IFS-whitespace run,
		// so an empty first TSV field shifts every field left (model="\$0.0072",
		// pct="30k" …) — a pre-existing script quirk for a degenerate input that
		// real model configs never produce. The renderer treats it sanely
		// (pinned as a unit case below) instead of replicating the scramble.
		{ name: "null percentage → 0%", input: doc({ context_window: { context_window_size: 1_000_000, used_percentage: null } }), width: 140, cwd: f.gitless, git: null },
		{ name: "missing pi block → cost $0 dropped", input: { model: { display_name: "GLM 5.3" }, context_window: { context_window_size: 200_000, used_percentage: 10 } }, width: 140, cwd: f.gitless, git: null },
		{ name: "HOME prefix maps to ~", input: doc(), width: 140, cwd: fixture!.homeProj, git: null, env: { HOME: fixture!.fakeHome }, home: fixture!.fakeHome },
		{ name: "CJK model name (char-counted widths)", input: doc({ model: { display_name: "中文字模型" } }), width: 100, cwd: f.gitless, git: null },
	];
};

if (hasJq) {
	for (const c of parityCases()) {
		test(`parity: ${c.name}`, async () => {
			await checkParity(c);
		});
	}
} else {
	test("parity matrix skipped: jq not on PATH", { skip: true }, () => {});
}

test("renderer: empty-string model name renders an empty model segment (documented divergence)", () => {
	// The bash oracle scrambles fields for this input (leading-IFS collapse,
	// see the matrix note above); the renderer keeps fields positional. An
	// empty model still consumes its slot (separator + empty text), exactly
	// like the script's add() would for a zero-length segment.
	const out = renderDefaultStatusline(doc({ model: { display_name: "" } }), 140, {
		cwd: "/tmp/x",
		home: "/Users/nobody",
		git: null,
	});
	const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plain, /^\/tmp\/x \u2502 {2}\u2502 Ctx 3% \(30k\/1M\) \u2502 \$0\.0072$/);
});
