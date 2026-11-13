/**
 * Fixed two-line footer, installed only in the interactive TUI.
 * Rendering and active-branch accounting are owned by this extension.
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { renderStatusline } from "./render.ts";
import { TpsTracker } from "./tps.ts";
import { BranchUsage } from "./usage.ts";

export default function statusline(pi: ExtensionAPI): void {
	const tps = new TpsTracker();
	let activeTui: TUI | undefined;

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		tps.onSessionStart(ctx.sessionManager.getSessionId(), event.reason);
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const usage = new BranchUsage();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose() {
					unsubscribeBranch();
					if (activeTui === tui) activeTui = undefined;
				},
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
							tps: tps.read(ctx.sessionManager, model),
							usesSubscription: model ? ctx.modelRuntime.isUsingSubscription(model.provider) : false,
							statuses: footerData.getExtensionStatuses(),
						},
						theme,
						width,
					);
				},
			};
		});
	});

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		tps.onMessageStart(event.message.role);
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (tps.onMessageUpdate(event.message.role, event.assistantMessageEvent)) {
			activeTui?.requestRender();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (tps.onMessageEnd(event.message)) {
			activeTui?.requestRender();
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		tps.onAgentEnd();
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeTui?.requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		tps.onSessionTree();
		activeTui?.requestRender();
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		tps.onSessionShutdown(ctx.sessionManager.getSessionId(), event.reason);
		activeTui = undefined;
		ctx.ui.setFooter(undefined);
	});
}
