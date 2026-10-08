/**
 * Isolated probe extension for H-T5 (XPKG-09-HOST, 2026-10-08 follow-up §4B):
 * a session_start handler that crosses a MACROTASK boundary (setTimeout 80ms)
 * BEFORE registering its aboveEditor widget — the original spec row the first
 * evidence batch did not exercise (ordinary late mounting only). Probe only;
 * renders one static line, never touches state.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function lateWidgetProbe(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const startedAt = Date.now();
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 80);
			t.unref?.();
		});
		const landedAt = Date.now();
		ctx.ui.setWidget(
			"late-probe-widget",
			() =>
				new Text(
					`◇ late-probe widget (session_start handler awaited a macrotask: ${landedAt - startedAt}ms before setWidget)`,
					0,
					0,
				),
			{ placement: "aboveEditor" },
		);
	});
}
