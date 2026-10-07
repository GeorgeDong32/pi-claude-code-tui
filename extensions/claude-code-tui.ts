/**
 * Claude Code TUI 复刻扩展（v2 — 全页面复刻）
 * 参考 Claude Code 官方源码 UI（spinnerVerbs / Clawd / BuiltinStatusLine / PromptInput /
 * AssistantToolUseMessage），在 pi 上复刻其 TUI 观感：
 * - 启动头：Clawd 吉祥物 + "Claude Code vX" + 模型名（第三方模型名原样保留）+ cwd
 * - 输入框：CC 式半开圆角边框（只有上下边）+ accent 块状光标（移植自 MIT 的
 *   pi-claude-code-tui 包，见 lib/claude-tui-editor.ts）
 * - 工具行（pi ≥ 1.0.1）：官方渲染器通道 pi.registerToolRenderer —— 单一
 *   resolver 按槽位（call/result/shell）合并 CC 渲染器与 next() 的原渲染器，
 *   内置七件 + 无自带渲染器的第三方/MCP 工具渲染为 CC 风格 `⏺ Tool(args)`
 *   + `⎿  输出`（错误红色、edit 带彩色 diff、read 折叠摘要），renderShell
 *   "self" 去掉背景盒；自带渲染器的第三方工具 auto 让路，显式 on
 *   （/claude-tools on）时接管（subagent / obs_recall 的 result 豁免）。
 *   只换渲染器，execute 与参数从不触碰；旧机制（registerTool 重注册
 *   内置七件 + ToolExecutionComponent 原型补丁）已删，spec
 *   2026-10-03-pi-1.0-tool-renderer-migration
 * - Thinking 折叠：折叠开关本身是 pi 原生设置（hideThinkingBlock / ctrl+t），
 *   本扩展只把折叠标签换成 CC 风格 `✻ Thinking… (ctrl+t to expand)`，
 *   并在用户未做过选择时一次性提示快捷键
 * - Spinner：✻ 花型动画 + Claude 橙 + CC 同款 187 词表（Clauding→Piing 彩蛋）——
 *   每 run 加权抽一个定终身（骨干词高频、彩蛋稀有，CC 本尊是等概率抽样不轮换），
 *   词面有 claudeShimmer 流光扫过 + (esc to interrupt · Ns)
 * - 收尾：✻ Worked for 12s（CC 过去式动词）
 * - 状态栏：模型 │ Context 23% (50k/200k) │ $0.042（/claude-footer 切换；
 *   开原生底栏时自动隐藏，避免与 pi-mcp-adapter / pi-lens 的 footer 重复）
 *
 * 入口结构（spec P2-1）：本文件只保留加载期注册（渲染器 resolver、packed
 * entry renderer、markdown transformer、命令）与事件路由；全部可变状态与
 * 生命周期归 lib/replica-session.ts 的 ReplicaSession。
 *
 * Commands:
 *   /claude-tui  — 开/关整套复刻 UI（头 / 输入框 / 转圈 / 状态栏；off 时工具行一并回 stock）
 *   /claude-tools — CC 工具行：on / off / auto（auto 碰到别家自动让路）
 *   /claude-verb — 立即换一个随机动词
 *   /claude-footer — 开/关原生底栏（开：兼容其它扩展 footer；关：CC 极简风）
 */

import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ccCall,
	ccThenRunCall,
	mcpArgsSummary,
	mcpDisplayName,
	callArgsFor,
	dotStatus,
	type CCTheme,
	ccResult,
	displayToolName,
	obsRecallDisplayView,
	packedEventRows,
} from "./lib/cc-rows.ts";
import { isBuiltinToolName, planResolverTakeover } from "./lib/takeover-rules.ts";
import { assistantWhiteText, userMessageBar } from "./lib/cc-markdown.ts";
import { patchCompactionRow, restoreCompactionRow } from "./lib/cc-compaction-row.ts";
import { patchSkillRow, restoreSkillRow } from "./lib/cc-skill-row.ts";
import { weightedVerbSample } from "./lib/spinner-verbs.ts";
import { SubagentPresentationBridge } from "./lib/subagent-presentation.ts";
import { drawCcAsyncFrame, drawCcFleetFrame } from "./lib/cc-subagent-rows.ts";
import { defaultPrefsPath } from "./lib/prefs.ts";
import { createNotificationAdapter, readPmStatus } from "./lib/pm-capability.ts";
import { createObsAdapter, type ObsSavingsSite } from "./lib/obs-savings.ts";
import { createCoreBusClient, createFooterChannel } from "./lib/core-bus.ts";
import { PrototypeMethodAdapter } from "./lib/pi-proto-adapter.ts";
import { ReplicaSession, type UiSlots } from "./lib/replica-session.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const gray = (s: string) => `\x1b[38;2;153;153;153m${s}\x1b[39m`;

export default function (pi: ExtensionAPI) {
	const prefsPath = defaultPrefsPath();

	// --- Thinking-block preference probe (tip gate; session owns the tip) ---
	const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
	const thinkingPrefExplicit = (): boolean => {
		try {
			if (!existsSync(settingsPath)) return false;
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hideThinkingBlock?: unknown };
			return typeof settings.hideThinkingBlock === "boolean";
		} catch {
			return true; // unreadable settings: stay quiet rather than nag
		}
	};

	// --- P0-2: one core-bus client for the three channels (notifications /
	// obs sites / display.footer); the session activates/closes it. The
	// notification sink and repaint hook are bound to the session right
	// after it exists (holders keep the adapters stable). ---
	const obsAdapter = createObsAdapter((sites: readonly ObsSavingsSite[]) => {
		pi.appendEntry("cc-tui/observation-packed", { sites });
	});
	let notifySink: (msg: string, level: string) => void = () => {};
	let repaint: () => void = () => {};
	const coreFooterChannel = createFooterChannel(() => repaint());

	// --- Subagent presentation bridge (spec P3): the CC fleet drawing over
	// pi-subagents' presentation seam; degraded to native on any failure. ---
	const subagentBridge = new SubagentPresentationBridge({
		events: pi.events,
		surfaces: { fleet: drawCcFleetFrame, async: drawCcAsyncFrame },
		onDiagnostic: (diagnostic) => {
			console.warn(`[claude-tui] subagent ${diagnostic.surface} drawing fell back to native: ${diagnostic.reason}`);
		},
	});

	// Compact CC-style user bars: UserMessageComponent wraps content in a Box
	// with hardcoded paddingY=1 (a blank row above and below the bar). Patch
	// rebuild to zero it — wrapper-style (the native rebuild runs FIRST, or
	// user messages vanish). Centralized lifecycle via the session's patches
	// dep (spec 8.3).
	const userBarAdapter = new PrototypeMethodAdapter({
		proto: UserMessageComponent.prototype,
		method: "rebuild",
		marker: "__ccCompact",
		hostMatches: (host): boolean => Array.isArray((host as { children?: unknown })?.children),
		body: (host, _fg, original) => {
			original?.call(host);
			for (const child of (host as { children?: Array<{ paddingY?: number }> }).children ?? []) {
				if (child && typeof child.paddingY === "number" && child.paddingY > 0) child.paddingY = 0;
			}
		},
	});

	// --- P2-1: the session owns every mutable state + lifecycle. ---
	const uiOf = (ctx: unknown): UiSlots => {
		const c = ctx as ExtensionContext & {
			sessionManager?: { getSessionId?: () => string; getBranch?: () => unknown[] };
		};
		const ui = c.ui as unknown as Record<string, ((...args: unknown[]) => void) | undefined> & {
			theme?: { fg(color: string, s: string): string; bold(s: string): string };
		};
		const fn = (name: string) => ui[name] as ((...args: unknown[]) => void) | undefined;
		return {
			mode: c.mode,
			notify: (message, level) => fn("notify")?.(message, level),
			setHeader: (factory) => fn("setHeader")?.(factory),
			setTitle: (title) => fn("setTitle")?.(title),
			setEditorComponent: (factory) => fn("setEditorComponent")?.(factory),
			setWidget: (key, content, options) => fn("setWidget")?.(key, content, options),
			setFooter: (factory) => fn("setFooter")?.(factory),
			setWorkingVisible: ui.setWorkingVisible ? (visible: boolean) => fn("setWorkingVisible")?.(visible) : undefined,
			setHiddenThinkingLabel: ui.setHiddenThinkingLabel
				? (label?: string) => fn("setHiddenThinkingLabel")?.(label)
				: undefined,
			setWorkingIndicator: (...args: unknown[]) => fn("setWorkingIndicator")?.(...args),
			setWorkingMessage: (...args: unknown[]) => fn("setWorkingMessage")?.(...args),
			theme: ui.theme,
			model: c.model as UiSlots["model"],
			cwd: c.cwd,
			branch: () => c.sessionManager?.getBranch?.() ?? [],
			sessionId: () => c.sessionManager?.getSessionId?.() ?? null,
		};
	};
	const coreBusClient = createCoreBusClient({
		adapters: [createNotificationAdapter((m, l) => notifySink(m, l)), obsAdapter.adapter, coreFooterChannel.adapter],
	});
	const session = new ReplicaSession({
		pi: pi as never,
		uiOf,
		coreBus: coreBusClient,
		obsAdapter,
		bridge: subagentBridge,
		patches: {
			applyAll: (getFg) => {
				patchCompactionRow(getFg);
				patchSkillRow(getFg);
				userBarAdapter.apply(() => null);
			},
			restoreAll: () => {
				restoreCompactionRow();
				restoreSkillRow();
				userBarAdapter.restore();
			},
		},
		prefsPath,
		readPmStatus,
		thinkingPrefExplicit,
		pickRunVerb: weightedVerbSample,
	});
	// Bind the sinks to the session (UiSlots stay current across session
	// switches; the footer repaint rides the session's dock).
	notifySink = session.displayNotification;
	repaint = () => session.requestRender();
	session.coreFooterLines = () => coreFooterChannel.lines();

	// --- CC tool rows via the official renderer channel (pi >= 1.0.1) ---
	// One resolver replaces the two pre-1.0 mechanisms. pi consults it per
	// ToolExecutionComponent construction, passing next() = what the remaining
	// resolvers, the registered tool, then pi's builtin renderer table would
	// use. Merging keeps every slot we don't own at its next() value; execute
	// is never touched (pure display layer). Spec: 2026-10-03-migration.
	// P1-1 R2: name → parameter schema cache for the generic summaries;
	// refreshed at session_start / enable / mcp_servers_change — the resolver
	// and renderers only READ it.
	let toolSchemas = new Map<string, import("./lib/tool-summary.ts").ToolParamSchema>();
	const refreshToolSchemas = (): void => {
		try {
			const next = new Map<string, import("./lib/tool-summary.ts").ToolParamSchema>();
			for (const tool of pi.getAllTools()) {
				if (tool?.name && tool.parameters) next.set(tool.name, tool.parameters as import("./lib/tool-summary.ts").ToolParamSchema);
			}
			toolSchemas = next;
		} catch {
			// getAllTools unavailable (early load window) — keep the last cache
		}
	};
	const schemaFor = (name: string): import("./lib/tool-summary.ts").ToolParamSchema | undefined => toolSchemas.get(name);
	if (typeof pi.registerToolRenderer !== "function") {
		// Loud guard, no silent optional-chain no-op (spec DEC-02): on pi 0.x
		// the extension still loads (git installs don't enforce peers), so say
		// why the tool rows stay stock. Register-time only, never per render.
		console.warn("[claude-tui] pi >= 1.0.1 required for CC tool rows (registerToolRenderer missing) — tool rows stay stock");
	} else {
		pi.registerToolRenderer((toolName, next) => {
			const orig = next();
			const decision = session.toolRowsDecisionInput();
			const plan = planResolverTakeover({
				channelActive: decision.channelActive,
				toolRowsEnabled: decision.toolRowsEnabled,
				forced: decision.forced,
				isMcp: mcpDisplayName(toolName) !== null,
				isBuiltin: isBuiltinToolName(toolName),
				hasOrigCall: Boolean(orig?.renderCall),
				hasOrigResult: Boolean(orig?.renderResult),
				toolName,
			});
			if (!plan) return orig;
			// Call factory — MCP badge / builtin seven / third-party + then_run
			// (TR D2/D3). P1-1 R4/R5: the proxy shape resolves only once args
			// are visible here (the resolver itself never sees args).
			const callFactory = (args: unknown, theme: unknown, rctx?: { isError?: boolean; isPartial?: boolean }) => {
				const mcpName = mcpDisplayName(toolName, args);
				const call = ccCall(
					theme as CCTheme,
					mcpName ?? displayToolName(toolName),
					mcpName ? mcpArgsSummary(args) : callArgsFor(toolName, args, schemaFor),
					dotStatus(rctx),
					undefined,
					// CC's userFacingName suffix (`server - tool (MCP)`).
					mcpName ? "(MCP)" : undefined,
				);
				// TR D3: fused write/edit calls carry then_run — in force mode
				// the core's own call badge is replaced by the CC row, so the
				// badge is re-stated here as a dim second row.
				const cmd = (args as { then_run?: { command?: string } } | null | undefined)?.then_run?.command;
				return ccThenRunCall(theme as CCTheme, call, cmd);
			};
			// Result factory: direct CC renderer (spec 8.4). obs_recall results
			// are shaped first (details-first, P1-1 R3); renderResult has NO
			// args parameter, so proxy MCP result titles fall back to the bare
			// tool name — never a module-level "last args" guess.
			const resultFactory = (result: unknown, options: { expanded?: boolean }, theme: unknown, rctx: { isError?: boolean }) => {
				let displayResult: unknown = result;
				if (toolName === "obs_recall") {
					const view = obsRecallDisplayView(result);
					if (view.header !== null) {
						const content = (result as { content?: unknown[] } | null | undefined)?.content;
						const kept = Array.isArray(content)
							? content.filter((block) => !(block != null && typeof block === "object" && (block as { type?: string }).type === "text"))
							: [];
						displayResult = { ...(result as object), content: [{ type: "text", text: view.text }, ...kept] };
					}
				}
				return ccResult(theme as CCTheme, mcpDisplayName(toolName) ?? displayToolName(toolName), displayResult, options, Boolean(rctx?.isError));
			};
			return {
				renderShell: plan.shell === "self" ? ("self" as const) : orig?.renderShell,
				renderCall: plan.call === "cc" ? callFactory : orig?.renderCall,
				renderResult: plan.result === "cc" ? resultFactory : orig?.renderResult,
			};
		});
	}

	// OBS-09-SITES packed entries: display-only CustomEntry rendered in the
	// conversation flow (registered at load; renderers never throw).
	pi.registerEntryRenderer<{ sites: ObsSavingsSite[] }>("cc-tui/observation-packed", (entry, _options, theme) => ({
		invalidate() {},
		render(width: number): string[] {
			try {
				const sites = entry.data?.sites;
				if (!Array.isArray(sites) || sites.length === 0) return [];
				return packedEventRows(theme as unknown as import("./lib/cc-rows.ts").CCTheme, sites, width);
			} catch {
				return []; // red line 1: render must never throw
			}
		},
	}));

	// --- Event routing (handlers stay thin; the session owns behavior) ---
	pi.on("session_start", async (_event, ctx) => {
		session.onSessionStart(ctx);
		refreshToolSchemas(); // P1-1 R2 (also refreshed inside enable's caller)
	});
	pi.on("session_before_compact", async (_event, ctx) => session.onCompactionStart(ctx));
	pi.on("session_compact", async (_event, ctx) => session.onCompactionEnd(ctx));
	pi.on("session_compact_failed", async () => session.onCompactionFailed());
	pi.on("message_end", async (_event, ctx) => session.onUsagePoint("message_end", ctx));
	pi.on("model_select", async (event) => session.onModelSelect((event as { model?: object }).model));
	pi.on("agent_start", async (_event, ctx) => session.onRunStart(ctx));
	pi.on("agent_settled", async (_event, ctx) => session.onRunSettled(ctx));
	pi.on("session_tree", async (_event, ctx) => session.onUsagePoint("session_tree", ctx));
	pi.on("session_shutdown", async (_event, ctx) => session.shutdown(ctx));
	pi.on("mcp_servers_change", async () => {
		if (session.isEnabled()) refreshToolSchemas();
	});

	// --- Commands (state changes live in the session) ---
	pi.registerCommand("claude-tui", {
		description: "Toggle the Claude Code TUI replica (header / editor / spinner / status line)",
		handler: async (_args, ctx) => {
			const enabled = session.toggle(ctx);
			ctx.ui.notify(`Claude Code TUI replica ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("claude-tools", {
		description: "CC tool rows: on | off | auto (auto yields to other TUI extensions)",
		handler: async (args, ctx) => {
			ctx.ui.notify(session.setToolRows(args, ctx), "info");
		},
	});

	pi.registerCommand("claude-verb", {
		description: "Reroll the Claude Code spinner verb",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`✻ ${session.rerollVerb()}…`, "info");
		},
	});

	pi.registerCommand("claude-footer", {
		description: "Toggle pi's native footer (on: keep MCP/other footers, hide CC status widget; off: CC-clean look)",
		handler: async (args, ctx) => {
			const { native } = session.setFooterModeFromCommand(args, ctx);
			ctx.ui.notify(
				`Native footer ${native ? "on — CC status widget hidden" : "off — CC status widget shown"}`,
				"info",
			);
		},
	});

	// Plan SL4: CC-compatible statusline (external script; JSON on stdin).
	pi.registerCommand("claude-statusline", {
		description: "Statusline: on | off | badge on|off | set <command>",
		handler: async (args, ctx) => {
			const message = session.setStatusline(args, ctx);
			if (message === null) {
				ctx.ui.notify("Usage: /claude-statusline [on|off|badge on|off|set <command>]", "info");
				return;
			}
			ctx.ui.notify(message, "info");
		},
	});

	// History user messages: CC-style slim bar. Assistant/user markdown
	// styling lives in lib/cc-markdown.ts (pure, table-tested); the
	// transformer itself only routes by message type.
	pi.registerMarkdownTransformer((markdown, { messageType, availableWidth }) => {
		if (messageType === "assistant") return assistantWhiteText(markdown);
		if (messageType !== "user") return markdown;
		return userMessageBar(markdown, Math.max(1, Math.floor(availableWidth ?? 80)), gray);
	});
}
