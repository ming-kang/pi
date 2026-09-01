/**
 * background — run bash commands in the background.
 *
 * Tools: a single `bg` tool with five actions. create starts a task and
 * returns immediately; the result arrives as a <background-task> notification
 * (steered into the run at the next turn boundary while streaming, waking the
 * agent when idle). read returns a bounded slice of a task's output file;
 * wait blocks (bounded) for a task's completion and delivers it inline — the
 * completion notification is suppressed so the completion is delivered exactly
 * once;
 * kill stops a single task; list enumerates known tasks. /bg opens the
 * interactive task manager. Running counts surface in the footer via
 * ctx.ui.setStatus.
 *
 * This file is wiring only: the actions live in actions.ts, the notification
 * in notify.ts, the transcript rows in render.ts, and the menu in manager.ts.
 */

import { getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { type BashOperations, createLocalBashOperations } from "../../core/tools/bash.ts";
import { describeTaskLine, runCreate, runKill, runList, runRead, runWait } from "./actions.ts";
import { BG_NOTIFICATION_TYPE } from "./constants.ts";
import { BackgroundTasksMenu } from "./manager.ts";
import { buildNotificationContent, toNotificationDetails } from "./notify.ts";
import { readOutputSlice } from "./output-file.ts";
import { BackgroundTaskRegistry } from "./registry.ts";
import {
	type BgRenderState,
	renderBackgroundNotification,
	renderBgCall,
	renderBgResult,
	type WaitLiveProbe,
} from "./render.ts";
import { BG_PROMPT_GUIDELINES, BG_PROMPT_SNIPPET, BG_TOOL_DESCRIPTION, bgSchema } from "./schema.ts";
import { formatStatusline } from "./task-view.ts";
import type { BgDetails, BgNotificationDetails } from "./types.ts";

/** Tasks shown by the non-TUI `/bg` fallback summary. */
const BG_COMMAND_SUMMARY_SHOWN = 10;

/**
 * Wrap operations so every executed command carries the prefix, mirroring the
 * built-in bash tool. The prefix never reaches task labels or notifications:
 * `BgTask.command` stays the user's original input.
 */
export function prependCommandPrefix(operations: BashOperations, prefix: string | undefined): BashOperations {
	if (!prefix) return operations;
	return {
		exec: (command, cwd, options) => operations.exec(`${prefix}\n${command}`, cwd, options),
	};
}

/** Hosts without getShellSettings (older SDK hosts): read what the session was configured with. */
function readDiskShellSettings(ctx: ExtensionContext): { shellPath?: string; commandPrefix?: string } {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	return { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
}

/** Local shell operations honoring the session's shell settings (shellPath, commandPrefix). */
function createSessionBashOperations(ctx: ExtensionContext): BashOperations {
	const shell = ctx.getShellSettings?.() ?? readDiskShellSettings(ctx);
	return prependCommandPrefix(createLocalBashOperations({ shellPath: shell.shellPath }), shell.commandPrefix);
}

export interface BackgroundExtensionOverrides {
	operations?: BashOperations;
	outputDir?: string;
	maxOutputBytes?: number;
	/** Stall watchdog tuning, or false to disable it; defaults follow Claude Code's CC-1175 (5s/45s/1KB). */
	stall?: { pollIntervalMs?: number; thresholdMs?: number; tailBytes?: number } | false;
}

/** Factory with injectable seams for tests; the default export uses production wiring. */
export function createBackgroundExtension(overrides?: BackgroundExtensionOverrides): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		let registry: BackgroundTaskRegistry | undefined;
		let sessionCtx: ExtensionContext | undefined;

		const requireRegistry = (): BackgroundTaskRegistry => {
			if (!registry) throw new Error("Background tasks are not available yet (no active session).");
			return registry;
		};

		/** Read-only live peek for the pending wait renderer; never throws. */
		const waitLiveProbe: WaitLiveProbe = (taskId) => {
			if (!registry) return undefined;
			const resolved = registry.resolveTask(taskId);
			return resolved.ok ? { status: resolved.task.status, outputBytes: resolved.task.outputBytes } : undefined;
		};

		const updateStatus = () => {
			if (!registry || registry.isShuttingDown) return;
			sessionCtx?.ui.setStatus("background", formatStatusline(registry.counts()));
		};

		pi.on("session_start", (_event, ctx) => {
			sessionCtx = ctx;
			// Defensive: a leftover registry (session_shutdown not seen) must not leak processes.
			if (registry) void registry.shutdown();
			registry = new BackgroundTaskRegistry({
				operations: overrides?.operations ?? createSessionBashOperations(ctx),
				outputDir: overrides?.outputDir,
				maxOutputBytes: overrides?.maxOutputBytes,
				stall: overrides?.stall,
				// Completion and stall reach the model the same way; that choice lives here only.
				onNotify: (notification) =>
					pi.sendMessage(
						{
							customType: BG_NOTIFICATION_TYPE,
							content: buildNotificationContent(notification),
							display: true,
							details: toNotificationDetails(notification),
						},
						// steer, not followUp: a task that finishes mid-run must reach the
						// model at the next turn boundary, not after the whole run ends.
						{ deliverAs: "steer", triggerTurn: true },
					),
				onChange: updateStatus,
			});
			updateStatus();
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			ctx.ui.setStatus("background", undefined);
			sessionCtx = undefined;
			const active = registry;
			registry = undefined;
			await active?.shutdown();
		});

		pi.registerTool<typeof bgSchema, BgDetails, BgRenderState>({
			name: "bg",
			label: "bg",
			description: BG_TOOL_DESCRIPTION,
			promptSnippet: BG_PROMPT_SNIPPET,
			promptGuidelines: BG_PROMPT_GUIDELINES,
			parameters: bgSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BgDetails>> {
				const active = requireRegistry();
				switch (params.action) {
					case "create":
						return runCreate(active, params, ctx);
					case "read":
						return runRead(active, params);
					case "wait":
						return runWait(active, params, signal);
					case "kill":
						return runKill(active, params);
					case "list":
						return runList(active);
				}
			},
			renderCall(args, theme, context) {
				return renderBgCall(args, theme, context, waitLiveProbe);
			},
			renderResult(result, options, theme, context) {
				return renderBgResult(result, options, theme, context);
			},
		});

		pi.registerMessageRenderer<BgNotificationDetails>(BG_NOTIFICATION_TYPE, renderBackgroundNotification);

		pi.registerCommand("bg", {
			description: "View and manage background tasks",
			handler: async (_args, ctx: ExtensionCommandContext) => {
				const active = registry;
				if (!active || active.counts().total === 0) {
					ctx.ui.notify("No background tasks.", "info");
					return;
				}
				if (ctx.mode !== "tui") {
					// RPC/print: ctx.ui.custom is unavailable — show a bounded summary.
					const now = Date.now();
					const lines = active
						.listTasks()
						.slice(0, BG_COMMAND_SUMMARY_SHOWN)
						.map((task) => describeTaskLine(task, now));
					ctx.ui.notify(
						`Background tasks:\n${lines.join("\n")}\nUse the bg tool (action kill) to stop a task.`,
						"info",
					);
					return;
				}
				await showBackgroundManager(ctx, active);
			},
		});
	};
}

async function showBackgroundManager(ctx: ExtensionCommandContext, registry: BackgroundTaskRegistry): Promise<void> {
	// No overlay options: the component mounts inline in the editor slot, like /model.
	await ctx.ui.custom(
		(tui, theme, keybindings, done) =>
			new BackgroundTasksMenu({
				tui,
				theme,
				keybindings,
				host: {
					listTasks: () => registry.listTasks(),
					killTask: (id) => registry.killTask(id),
					readSlice: (filePath, options) => readOutputSlice(filePath, options),
				},
				onClose: () => done(undefined),
			}),
	);
}

export default createBackgroundExtension();
