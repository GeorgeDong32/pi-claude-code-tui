/**
 * Read-modify-write preference store for ~/.pi/agent/claude-tui.json (plan SL2).
 *
 * The old saveToolRowsPref serialized `{ toolRows }` alone, wiping every other
 * key — fine with one tenant, fatal once statusLine moved in. All writers go
 * through savePrefs, which merges into the on-disk object and swaps files
 * atomically (tmp + rename), so /claude-tools and /claude-statusline cannot
 * clobber each other.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StatusLinePrefs {
	/** Statusline row rendered at all (default false). */
	enabled: boolean;
	/** Shell command fed the CC-shaped JSON on stdin; "" = bundled default script. */
	command: string;
	/** Right-aligned CC-style effort chip on the first statusline line. */
	badge: boolean;
}

export interface ClaudeTuiPrefs {
	toolRows?: boolean;
	statusLine?: Partial<StatusLinePrefs>;
}

export const defaultPrefsPath = (): string =>
	join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "claude-tui.json");

/** Read the whole prefs object; unreadable/corrupt/absent → `{}`. */
export function loadPrefs(path = defaultPrefsPath()): ClaudeTuiPrefs {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeTuiPrefs;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed;
	} catch {
		return {};
	}
}

/**
 * Merge `partial` into the on-disk prefs and write atomically. `undefined`
 * values delete their key (JSON.stringify drops them), matching the old
 * "clear the toolRows pref" behavior without touching sibling keys. A write
 * failure must never break the TUI.
 */
export function savePrefs(partial: ClaudeTuiPrefs, path = defaultPrefsPath()): void {
	try {
		const merged: ClaudeTuiPrefs = { ...loadPrefs(path), ...partial };
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
		renameSync(tmp, path);
	} catch {
		// Never break the TUI over a preference write.
	}
}

/** Fill statusLine defaults: disabled, bundled command, badge on. */
export function resolveStatusLinePrefs(raw: Partial<StatusLinePrefs> | undefined): StatusLinePrefs {
	return {
		enabled: raw?.enabled === true,
		command: typeof raw?.command === "string" ? raw.command : "",
		badge: raw?.badge !== false,
	};
}
