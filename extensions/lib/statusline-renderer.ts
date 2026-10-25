/**
 * SP1 (docs/STATUSLINE-PERF-PLAN.md): pure in-process port of the bundled
 * default statusline script (statusline-default-script.ts / scripts/
 * statusline-default.sh). The script stays as the parity oracle —
 * test/statusline-renderer.test.ts pins this renderer's output
 * byte-for-byte against `bash -c <script>` for the same inputs.
 *
 * Porting contracts (verified empirically, see plan §3.1):
 * - Length math = CHARACTERS: bash `${#var}` counts chars in a multibyte
 *   locale (measured: "◆ main 2" → 8 under both C-locale and LANG=UTF-8 on
 *   macOS bash 3.2), so JS `.length` matches for BMP text. Astral plane
 *   graphemes would differ (bash 1 char / JS 2 units) — the statusline
 *   never produces them; the golden matrix keeps it that way.
 * - jq `//` truthiness: the alternative applies to null/false ONLY (0 and
 *   "" are truthy in jq). jqAlt replicates exactly that — not `??`, not `||`.
 * - Number formatting: jq and JS both print IEEE-754 doubles minimally, and
 *   every arithmetic step here (tok rounding, cost cents) is the same double
 *   math on both sides, so String() output is identical for golden values.
 * - The git segment is INJECTED by the caller (SP2 git-segment-provider).
 *   For byte parity the caller must hand over what `git status -b
 *   --porcelain` would show: branch `main`, detached literally
 *   "HEAD (no branch)", non-repo → git: null. That mapping is the
 *   provider's job, not the renderer's.
 * - Width arrives as a number (the session layer applies the same
 *   `statuslineWidth || 100` floor the spawn path always had via
 *   OVERRIDE_TERM_WIDTH); 0 renders dir-only exactly like the script's
 *   numeric-zero width.
 */

/** jq `//` alternative operator: null/false/undefined → alt, 0/"" stay. */
export function jqAlt<T>(value: T | null | undefined | false, alt: NonNullable<T> | T): T {
	return value === null || value === undefined || value === false ? alt : value;
}

/** CC palette ANSI paints — same byte sequences as the script. */
export const SL_ANSI = {
	RESET: "\x1b[39m",
	DIR: "\x1b[38;2;229;229;229m",
	GIT: "\x1b[38;2;154;205;255m",
	MODEL: "\x1b[38;2;255;175;0m",
	CTX: "\x1b[38;2;152;152;152m",
	SEP: "\x1b[38;2;120;120;120m",
} as const;

/** What the SP2 git-segment-provider hands the renderer. */
export interface StatuslineGitSegment {
	branch: string;
	dirty: number;
}

export interface RenderDefaultStatuslineOptions {
	/** Working directory shown as the leading segment (default: process.cwd()). */
	cwd?: string;
	/** HOME for the `~/` prefix substitution (default: process.env.HOME). */
	home?: string;
	/** Git segment as `git status -b --porcelain` would report it; null/undefined = no git segment. */
	git?: StatuslineGitSegment | null;
}

/**
 * jq `tok`: ≥1M → "X.XM", ≥1k → "Xk", else raw. Round-ties semantics agree
 * for the non-negative tokens that can reach here (positive ties: both away
 * from zero / toward +∞).
 */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) {
		return `${Math.round((n / 1_000_000) * 10) / 10}M`;
	}
	if (n >= 1000) {
		return `${Math.round(n / 1000)}k`;
	}
	return `${n}`;
}

/**
 * jq cost rule from the script: ≥$0.01 → cents precision ("$0.04", "$1.5",
 * "$2"); below → raw ("$0.0072", "$0.009"). Exactly "$0" means zero and is
 * dropped by the composer (same `[ "$coststr" != "$0" ]` guard).
 */
export function formatCost(usd: number): string {
	if (usd >= 0.01) {
		return `$${Math.round(usd * 100) / 100}`;
	}
	return `$${usd}`;
}

function asNumber(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Render the default statusline row (single line, no trailing newline — the
 * bash oracle's stdout is this string + "\n"). Byte-identical to
 * `bash -c DEFAULT_STATUSLINE_SCRIPT` fed the same JSON doc, width, cwd and
 * git state; segments compose left-to-right and drop right-to-left when the
 * width cannot fit them (same `fits` math: plain + 3 sep + segment + 1 gap).
 */
export function renderDefaultStatusline(input: unknown, width: number, options: RenderDefaultStatuslineOptions = {}): string {
	const doc = (input ?? {}) as {
		model?: { display_name?: unknown } | null;
		pi?: { cost_usd?: unknown } | null;
		context_window?: { used_percentage?: unknown; context_window_size?: unknown } | null;
	};

	const rawName = jqAlt(doc?.model?.display_name, "?");
	const model = typeof rawName === "string" ? rawName : `${rawName}`;
	const costUsd = asNumber(jqAlt(doc?.pi?.cost_usd, 0));
	const pct = asNumber(jqAlt(doc?.context_window?.used_percentage, 0));
	const windowSize = asNumber(jqAlt(doc?.context_window?.context_window_size, 0));

	const costStr = formatCost(costUsd);
	const pctStr = `${pct}%`;
	const usedTok = formatTokens(Math.round((pct * windowSize) / 100));
	const winTok = formatTokens(windowSize);

	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? process.env.HOME ?? "";
	const dir = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

	// Compose right-to-left dropping, mirroring the script's add()/fits().
	let plain = 0;
	let seg = "";
	const add = (paint: string, text: string): void => {
		if (seg !== "") {
			plain += 3;
			seg += `${SL_ANSI.SEP} │ ${SL_ANSI.RESET}`;
		}
		plain += text.length;
		seg += `${paint}${text}${SL_ANSI.RESET}`;
	};
	const fits = (segmentWidth: number): boolean => plain + 3 + segmentWidth + 1 <= width;

	plain += dir.length;
	seg = `${SL_ANSI.DIR}${dir}${SL_ANSI.RESET}`;

	const git = options.git ?? null;
	if (git && git.branch !== "") {
		const gitSeg = `◆ ${git.branch} ${git.dirty}`;
		if (fits(gitSeg.length)) add(SL_ANSI.GIT, gitSeg);
	}
	if (fits(model.length)) add(SL_ANSI.MODEL, model);
	const ctxSeg = `Ctx ${pctStr} (${usedTok}/${winTok})`;
	if (fits(ctxSeg.length)) add(SL_ANSI.CTX, ctxSeg);
	if (costStr !== "$0" && fits(costStr.length)) add(SL_ANSI.CTX, costStr);

	return seg;
}
