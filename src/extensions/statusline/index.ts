/**
 * Fixed two-line footer, installed only in the interactive TUI.
 * Rendering and active-branch accounting are owned by this extension.
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { renderStatusline } from "./render.ts";
import { BranchUsage } from "./usage.ts";

export default function statusline(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const usage = new BranchUsage();
			return {
				dispose: footerData.onBranchChange(() => tui.requestRender()),
				invalidate() {
					usage.invalidate();
				},
				render(width: number): string[] {
					const model = ctx.model;
					return renderStatusline(
						{
							model,
							thinkingLevel: ctx.thinkingLevel ?? "off",
							cwd: ctx.cwd,
							home: process.env.USERPROFILE || process.env.HOME || "",
							gitBranch: footerData.getGitBranch(),
							contextUsage: ctx.getContextUsage(),
							usage: usage.read(ctx.sessionManager),
							usesSubscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
							statuses: footerData.getExtensionStatuses(),
						},
						theme,
						width,
					);
				},
			};
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}
