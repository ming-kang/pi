/** bg is an observer/controller of the public session-owned Background capability. */
import { isBackgroundTerminal } from "../../core/background/types.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { boundedText, describeTaskLine, runKill, runList, runRead, runWait } from "./actions.ts";
import { renderBackgroundCompletion } from "./completion-render.ts";
import { BG_COMPLETION_TYPE, BG_NOTIFICATION_TYPE } from "./constants.ts";
import { BackgroundTasksMenu } from "./manager.ts";
import { type BgRenderState, renderBackgroundNotification, renderBgCall, renderBgResult } from "./render.ts";
import { BG_PROMPT_GUIDELINES, BG_PROMPT_SNIPPET, BG_TOOL_DESCRIPTION, bgSchema } from "./schema.ts";
import type { BgDetails, BgNotificationDetails } from "./types.ts";

export function createBackgroundExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		let unsubscribe: (() => void) | undefined;
		let closeMenu: (() => void) | undefined;
		pi.on("session_start", (_event, ctx) => {
			unsubscribe?.();
			const update = () => {
				const tasks = ctx.background.list();
				const running = tasks.filter((task) => !isBackgroundTerminal(task.status)).length;
				ctx.ui.setStatus(
					"background",
					tasks.length ? `bg ${running} active · ${tasks.length - running} finished` : undefined,
				);
			};
			unsubscribe = ctx.background.subscribe(update);
			update();
		});
		pi.on("session_shutdown", (_event, ctx) => {
			unsubscribe?.();
			unsubscribe = undefined;
			closeMenu?.();
			closeMenu = undefined;
			ctx.ui.setStatus("background", undefined);
		});
		pi.registerTool<typeof bgSchema, BgDetails, BgRenderState>({
			name: "bg",
			label: "bg",
			description: BG_TOOL_DESCRIPTION,
			promptSnippet: BG_PROMPT_SNIPPET,
			promptGuidelines: BG_PROMPT_GUIDELINES,
			parameters: bgSchema,
			async execute(_id, params, signal, _onUpdate, ctx) {
				try {
					switch (params.action) {
						case "read":
							return await runRead(ctx.background, params);
						case "wait":
							return await runWait(ctx.background, params, signal);
						case "kill":
							return runKill(ctx.background, params);
						case "list":
							return runList(ctx.background);
					}
				} catch (error) {
					throw new Error(boundedText(error instanceof Error ? error.message : String(error)));
				}
			},
			renderCall: renderBgCall,
			renderResult: renderBgResult,
		});
		// Stored legacy create results and notification details remain renderable.
		pi.registerMessageRenderer<BgNotificationDetails>(BG_NOTIFICATION_TYPE, renderBackgroundNotification);
		pi.registerMessageRenderer(BG_COMPLETION_TYPE, renderBackgroundCompletion);
		pi.registerCommand("bg", {
			description: "View and manage Bash tasks and Subagent groups",
			handler: async (_args, ctx) => {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(
						boundedText(
							ctx.background
								.list()
								.slice(0, 10)
								.map((task) => describeTaskLine(task))
								.join("\n"),
						) || "No managed executions.",
						"info",
					);
					return;
				}
				closeMenu?.();
				await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
					const close = () => {
						if (closeMenu === close) closeMenu = undefined;
						done();
					};
					closeMenu = close;
					return new BackgroundTasksMenu({ tui, theme, keybindings, host: ctx.background, onClose: close });
				});
			},
		});
	};
}
export default createBackgroundExtension();
