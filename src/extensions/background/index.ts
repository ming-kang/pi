/**
 * background — run bash commands in the background.
 *
 * Tools: bg_bash starts a task and returns immediately; the result arrives as
 * a <background-task> notification (queued behind the current run while
 * streaming, waking the agent when idle). bg_logs reads a bounded slice of a
 * task's output file; bg_kill stops a single task. /bg opens the interactive
 * task manager. Running counts surface in the footer via ctx.ui.setStatus.
 */

import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { type BashOperations, createLocalBashOperations, resolveSpawnContext } from "../../core/tools/bash.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { BackgroundTasksMenu } from "./manager.ts";
import {
	BackgroundTaskRegistry,
	type BgTask,
	type BgTaskNotification,
	type BgTaskStatus,
	formatDuration,
	type ResolveTaskResult,
	readOutputSlice,
} from "./registry.ts";
import {
	commandLabel,
	renderBackgroundNotification,
	renderBgBashCall,
	renderBgBashResult,
	renderBgKillCall,
	renderBgLogsCall,
} from "./render.ts";

export const BG_NOTIFICATION_TYPE = "background-task";
const BG_LOGS_DEFAULT_BYTES = 8 * 1024;
const BG_LOGS_MIN_BYTES = 256;

const bgBashSchema = Type.Object({
	command: Type.String({ description: "Bash command to run in the background" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds (optional, no default; must be positive). On expiry the task is killed and reported as timeout.",
		}),
	),
});

const bgLogsSchema = Type.Object({
	taskId: Type.String({ description: "Task id; a unique prefix is accepted (e.g. 'bg-3f' or '3f')" }),
	mode: Type.Optional(
		Type.Union([Type.Literal("tail"), Type.Literal("head")], {
			description: "Read from the end (default) or the start of the output",
		}),
	),
	bytes: Type.Optional(
		Type.Number({
			description: `Max bytes to return (default ${BG_LOGS_DEFAULT_BYTES}, max ${DEFAULT_MAX_BYTES})`,
		}),
	),
});

const bgKillSchema = Type.Object({
	taskId: Type.String({ description: "Task id; a unique prefix is accepted" }),
});

export type BgBashInput = Static<typeof bgBashSchema>;
export type BgLogsInput = Static<typeof bgLogsSchema>;
export type BgKillInput = Static<typeof bgKillSchema>;

export interface BgBashDetails {
	taskId: string;
	outputPath: string;
	command: string;
}

export interface BgLogsDetails {
	taskId: string;
	mode: "head" | "tail";
	sliceBytes: number;
	totalBytes: number;
	outputPath: string;
}

export interface BgKillDetails {
	taskId: string;
	command: string;
}

export interface BgNotificationDetails {
	taskId: string;
	command: string;
	status: BgTaskStatus;
	exitCode: number | null | undefined;
	runtimeMs: number;
	outputPath: string;
	totalBytes: number;
	tailText: string;
	tailTruncated: boolean;
	error?: string;
	tailError?: string;
}

export function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function buildNotificationContent(notification: BgTaskNotification): string {
	const task = notification.task;
	const runtime = formatDuration((task.endedAt ?? task.startedAt) - task.startedAt);
	const exitCode = task.exitCode === undefined || task.exitCode === null ? "" : ` exitCode="${task.exitCode}"`;
	const lines = [
		`<background-task id="${task.id}" status="${task.status}"${exitCode} runtime="${runtime}">`,
		`<command>${escapeXml(task.command)}</command>`,
		`<output-file>${escapeXml(task.outputPath)}</output-file>`,
	];
	if (task.error) {
		lines.push(`<error>${escapeXml(task.error)}</error>`);
	}
	if (notification.tailError) {
		lines.push(`<output-tail unavailable="${escapeXml(notification.tailError)}"/>`);
	} else {
		const attrs = [
			`bytes="${notification.tailBytes}"`,
			`totalBytes="${notification.totalBytes}"`,
			notification.tailTruncated ? 'truncated="true"' : "",
			notification.tailStartsMidLine ? 'startsMidLine="true"' : "",
		]
			.filter(Boolean)
			.join(" ");
		const tail = notification.tailText.length > 0 ? escapeXml(notification.tailText) : "(no output)";
		lines.push(`<output-tail ${attrs}>`, tail.trimEnd(), "</output-tail>");
	}
	lines.push("</background-task>");
	return lines.join("\n");
}

export function formatStatusline(counts: { running: number; total: number }): string | undefined {
	if (counts.total === 0) return undefined;
	const ended = counts.total - counts.running;
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`${counts.running} running`);
	if (ended > 0) parts.push(`${ended} done`);
	return `bg ${parts.join(" · ")}`;
}

function describeResolveFailure(input: string, result: ResolveTaskResult & { ok: false }): string {
	if (result.reason === "ambiguous") {
		const lines = result.candidates.map((task) => `  ${task.id} (${task.status})  ${commandLabel(task.command, 60)}`);
		return `Task id "${input}" is ambiguous. Candidates:\n${lines.join("\n")}`;
	}
	return `No background task matches "${input}". Check the id returned by bg_bash or open /bg.`;
}

function describeTaskLine(task: BgTask, now: number): string {
	const duration = formatDuration((task.endedAt ?? now) - task.startedAt);
	const exit = task.exitCode !== undefined && task.exitCode !== null ? ` exit ${task.exitCode}` : "";
	return `  ${task.id}  ${task.status}${exit}  ${duration}  ${commandLabel(task.command, 40)}`;
}

function toNotificationDetails(notification: BgTaskNotification): BgNotificationDetails {
	const task = notification.task;
	return {
		taskId: task.id,
		command: task.command,
		status: task.status,
		exitCode: task.exitCode,
		runtimeMs: (task.endedAt ?? task.startedAt) - task.startedAt,
		outputPath: task.outputPath,
		totalBytes: notification.totalBytes,
		tailText: notification.tailText,
		tailTruncated: notification.tailTruncated,
		error: task.error,
		tailError: notification.tailError,
	};
}

export interface BackgroundExtensionOverrides {
	operations?: BashOperations;
	outputDir?: string;
	maxOutputBytes?: number;
}

/** Local shell operations honoring the session's configured shell path. */
function createSessionBashOperations(ctx: ExtensionContext): BashOperations {
	const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	});
	return createLocalBashOperations({ shellPath: settings.getShellPath() });
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

		const resolveTaskOrThrow = (taskId: string): BgTask => {
			const resolved = requireRegistry().resolveTask(taskId);
			if (!resolved.ok) throw new Error(describeResolveFailure(taskId, resolved));
			return resolved.task;
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
				onNotify: (notification) => {
					pi.sendMessage(
						{
							customType: BG_NOTIFICATION_TYPE,
							content: buildNotificationContent(notification),
							display: true,
							details: toNotificationDetails(notification),
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
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

		pi.registerTool<typeof bgBashSchema, BgBashDetails>({
			name: "bg_bash",
			label: "bg bash",
			description:
				"Run a bash command in the background and return immediately with a task id and output file path. " +
				"The result (status, exit code, output tail) arrives automatically as a <background-task> notification " +
				"when the task ends. Use for long-running commands such as dev servers, watch builds, or slow tests. " +
				"Optionally provide a timeout in seconds.",
			promptSnippet: "Run bash commands in the background (bg_bash); results arrive automatically",
			promptGuidelines: [
				"Use bg_bash for long-running commands (servers, builds, slow tests). Never poll for completion with sleep loops or repeated bg_logs; the <background-task> notification arrives automatically when the task ends. Use bg_logs for an early peek at a running task and bg_kill to stop one.",
			],
			parameters: bgBashSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<BgBashDetails>> {
				if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0)) {
					throw new Error("Invalid timeout: must be a positive number of seconds.");
				}
				// Same PI_* session variables as the built-in bash tool, snapshotted at start.
				const spawnContext = resolveSpawnContext(params.command, ctx.cwd, undefined, true, ctx);
				// Deliberately ignore the turn signal: aborting the current turn must
				// not kill the background task (that is what bg_kill is for).
				const task = requireRegistry().startTask({
					command: params.command,
					cwd: ctx.cwd,
					timeoutSeconds: params.timeout,
					env: spawnContext.env,
				});
				const text = [
					`Started background task ${task.id}.`,
					`Output file: ${task.outputPath}`,
					"",
					"Do NOT poll for completion (no sleep loops, no repeated bg_logs). A <background-task> " +
						"notification with the result and output tail arrives automatically when the task ends — " +
						"continue independent work or end the turn. Use bg_logs for an early peek, bg_kill to stop it.",
				].join("\n");
				return {
					content: [{ type: "text", text }],
					details: { taskId: task.id, outputPath: task.outputPath, command: params.command },
				};
			},
			renderCall(args, theme, context) {
				return renderBgBashCall(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderBgBashResult(result, options, theme, context);
			},
		});

		pi.registerTool<typeof bgLogsSchema, BgLogsDetails>({
			name: "bg_logs",
			label: "bg logs",
			description:
				`Read a bounded slice of a background task's output file (default: last ${formatSize(BG_LOGS_DEFAULT_BYTES)}, ` +
				`max ${formatSize(DEFAULT_MAX_BYTES)}). Works while the task is still running. ` +
				"Do not call this in a polling loop; completion arrives as a notification.",
			parameters: bgLogsSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<BgLogsDetails>> {
				const task = resolveTaskOrThrow(params.taskId);
				const mode = params.mode ?? "tail";
				const maxBytes = Math.min(
					DEFAULT_MAX_BYTES,
					Math.max(BG_LOGS_MIN_BYTES, Math.floor(params.bytes ?? BG_LOGS_DEFAULT_BYTES)),
				);
				let slice: Awaited<ReturnType<typeof readOutputSlice>>;
				try {
					slice = await readOutputSlice(task.outputPath, { mode, maxBytes });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(
						`Could not read output for ${task.id} (${task.status}): ${message}\nOutput file: ${task.outputPath}`,
					);
				}
				const text = sanitizeBinaryOutput(slice.text);
				const noticeParts = slice.truncated
					? [
							`${mode} ${formatSize(slice.sliceBytes)} of ${formatSize(slice.totalBytes)}`,
							`task ${task.id} ${task.status}`,
							...(slice.startsMidLine ? ["first line may be partial"] : []),
							`full output: ${task.outputPath}`,
						]
					: [
							`task ${task.id} ${task.status}`,
							`${formatSize(slice.totalBytes)} total`,
							`output: ${task.outputPath}`,
						];
				const body = text.length > 0 ? text : "(no output yet)";
				return {
					content: [{ type: "text", text: `[${noticeParts.join(" · ")}]\n${body}` }],
					details: {
						taskId: task.id,
						mode,
						sliceBytes: slice.sliceBytes,
						totalBytes: slice.totalBytes,
						outputPath: task.outputPath,
					},
				};
			},
			renderCall(args, theme) {
				return renderBgLogsCall(args, theme);
			},
		});

		pi.registerTool<typeof bgKillSchema, BgKillDetails>({
			name: "bg_kill",
			label: "bg kill",
			description:
				"Kill a running background task (the whole process tree). The terminal status and output tail " +
				"still arrive as the task's completion notification.",
			parameters: bgKillSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<BgKillDetails>> {
				const task = resolveTaskOrThrow(params.taskId);
				const result = requireRegistry().killTask(task.id);
				if (!result.killed) {
					const exit = task.exitCode !== undefined && task.exitCode !== null ? `, exit ${task.exitCode}` : "";
					throw new Error(`Task ${task.id} is not running (status: ${task.status}${exit}).`);
				}
				return {
					content: [
						{
							type: "text",
							text: `Killed task ${task.id}. A completion notification follows once the process tree is reaped.`,
						},
					],
					details: { taskId: task.id, command: task.command },
				};
			},
			renderCall(args, theme) {
				return renderBgKillCall(args, theme);
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
					const lines = active
						.listTasks()
						.slice(0, 10)
						.map((task) => describeTaskLine(task, Date.now()));
					ctx.ui.notify(`Background tasks:\n${lines.join("\n")}\nUse bg_kill <id> to stop a task.`, "info");
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
