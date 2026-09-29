/** bg is an observer/controller of the public session-owned Background capability. */
import "./keybindings.ts";
import { getKeybindings } from "@earendil-works/pi-tui";
import { isBackgroundTerminal } from "../../core/background/types.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { boundedText, describeTaskLine, runKill, runList, runRead, runWait } from "./actions.ts";
import { renderBackgroundCompletion } from "./completion-render.ts";
import { BG_COMPLETION_TYPE, BG_DETACH_HINT_DELAY_MS, BG_NOTIFICATION_TYPE } from "./constants.ts";
import { BackgroundTasksMenu } from "./manager.ts";
import { type BgRenderState, renderBackgroundNotification, renderBgCall, renderBgResult } from "./render.ts";
import { BG_PROMPT_GUIDELINES, BG_PROMPT_SNIPPET, BG_TOOL_DESCRIPTION, bgSchema } from "./schema.ts";
import type { BgDetails, BgNotificationDetails } from "./types.ts";

export function createBackgroundExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		let unsubscribe: (() => void) | undefined;
		let unsubscribeDetachKey: (() => void) | undefined;
		let closeMenu: (() => void) | undefined;
		let hintTimer: ReturnType<typeof setTimeout> | undefined;
		pi.on("session_start", (_event, ctx) => {
			unsubscribe?.();
			unsubscribeDetachKey?.();
			const update = () => {
				clearTimeout(hintTimer);
				hintTimer = undefined;
				const all = ctx.background.list();
				// The counts cover backgrounded work only; foreground executions are already
				// visible as ordinary tool rows in the transcript.
				const tasks = all.filter((task) => task.mode === "background");
				const running = tasks.filter((task) => !isBackgroundTerminal(task.status)).length;
				const parts: string[] = [];
				if (tasks.length) parts.push(`bg ${running} active · ${tasks.length - running} finished`);
				// Teach the detach key once something has run long enough to be worth moving, and
				// only while it can move: a stopping execution is aborted, so the key does nothing.
				const detachKey = keyLabel("app.backgroundTasks.detach");
				const now = Date.now();
				const movable = all.filter(
					(task) => task.mode === "foreground" && (task.status === "running" || task.status === "queued"),
				);
				const waits = movable
					.map((task) => task.startedAt + BG_DETACH_HINT_DELAY_MS - now)
					.filter((wait) => wait > 0);
				if (detachKey && movable.length > waits.length) parts.push(`${detachKey} to background`);
				if (detachKey && waits.length > 0) {
					// The service notifies on state changes, not on time, so wake up when the next
					// execution crosses the threshold.
					hintTimer = setTimeout(update, Math.min(...waits));
					hintTimer.unref?.();
				}
				ctx.ui.setStatus("background", parts.length ? parts.join(" · ") : undefined);
			};
			unsubscribe = ctx.background.subscribe(update);
			unsubscribeDetachKey = ctx.ui.onTerminalInput((data) => {
				if (!getKeybindings().matches(data, "app.backgroundTasks.detach")) return undefined;
				const count = ctx.background.detachForeground();
				// Nothing can move: let the key fall through to editor bindings instead of
				// spending it on a "nothing happened" status line.
				if (count === 0) return undefined;
				ctx.ui.notify(
					`Moved ${count} execution${count === 1 ? "" : "s"} to the background. Use /bg to manage tasks.`,
				);
				return { consume: true };
			});
			update();
		});
		pi.on("session_shutdown", (_event, ctx) => {
			unsubscribe?.();
			unsubscribe = undefined;
			unsubscribeDetachKey?.();
			unsubscribeDetachKey = undefined;
			clearTimeout(hintTimer);
			hintTimer = undefined;
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
			constrainedSampling: { type: "json_schema", strict: "prefer" },
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
					// Lookup failures already carry the current task list from actions.ts.
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(boundedText(message));
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
								.filter((task) => task.mode === "background")
								.slice(0, 10)
								.map((task) => describeTaskLine(task))
								.join("\n"),
						) || "No background tasks.",
						"info",
					);
					return;
				}
				closeMenu?.();
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						const close = () => {
							if (closeMenu === close) closeMenu = undefined;
							done();
						};
						closeMenu = close;
						return new BackgroundTasksMenu({ tui, theme, keybindings, host: ctx.background, onClose: close });
					},
					{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
				);
			},
		});
	};
}
export default createBackgroundExtension();
