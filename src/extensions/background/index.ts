/**
 * background — run bash commands in the background.
 *
 * Tools: a single `bg` tool with five actions. create starts a task and
 * returns immediately; the result arrives as a <background-task> notification
 * (queued behind the current run while streaming, waking the agent when
 * idle). read returns a bounded slice of a task's output file; wait blocks
 * (bounded) for a task's completion and delivers it inline — the followUp
 * notification is suppressed so the completion is delivered exactly once;
 * kill stops a single task; list enumerates known tasks. /bg opens the
 * interactive task manager. Running counts surface in the footer via
 * ctx.ui.setStatus.
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
import {
	type BashOperations,
	createLocalBashOperations,
	MAX_TIMEOUT_SECONDS,
	resolveSpawnContext,
} from "../../core/tools/bash.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { BackgroundTasksMenu } from "./manager.ts";
import {
	BackgroundTaskRegistry,
	BG_WAIT_DEFAULT_MS,
	BG_WAIT_MAX_MS,
	BG_WAIT_MIN_MS,
	type BgStallNotification,
	type BgTask,
	type BgTaskNotification,
	type BgTaskStatus,
	firstCommandLine,
	formatDuration,
	type ResolveTaskResult,
	readOutputSince,
	readOutputSlice,
} from "./registry.ts";
import {
	commandLabel,
	renderBackgroundNotification,
	renderBgCall,
	renderBgResult,
	type WaitLiveProbe,
} from "./render.ts";

export const BG_NOTIFICATION_TYPE = "background-task";
const BG_LOGS_DEFAULT_BYTES = 8 * 1024;
const BG_LOGS_MIN_BYTES = 256;
const BG_LIST_FINISHED_SHOWN = 5;
/** Bounded output delta returned by a successful wait. */
const BG_WAIT_DELTA_BYTES = 32 * 1024;
/** Tail peek included in a wait timeout result so progress stays visible. */
const BG_WAIT_PEEK_BYTES = 2 * 1024;

const bgSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("create"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")],
		{ description: "Which background-task operation to perform" },
	),
	// — create —
	command: Type.Optional(
		Type.String({ description: "Bash command to run in the background (create). Do not append '&'" }),
	),
	description: Type.Optional(
		Type.String({
			description: "Short label for the task, shown in /bg and notifications, e.g. 'dev server' (create)",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Kill the task after this many seconds; on expiry it is reported as timeout (create)",
		}),
	),
	// — read / wait / kill —
	taskId: Type.Optional(
		Type.String({ description: "Task id; a unique prefix is accepted, e.g. 'bg-3f' or '3f' (read/wait/kill)" }),
	),
	// — read —
	mode: Type.Optional(
		Type.Union([Type.Literal("tail"), Type.Literal("head")], {
			description: "Read from the end (default) or the start of the output (read)",
		}),
	),
	bytes: Type.Optional(
		Type.Number({
			description: `Max bytes to return (read, default ${formatSize(BG_LOGS_DEFAULT_BYTES)}, max ${formatSize(DEFAULT_MAX_BYTES)})`,
		}),
	),
	// — wait —
	waitMs: Type.Optional(
		Type.Number({
			description: `Max time to wait in ms, default ${BG_WAIT_DEFAULT_MS}, max ${BG_WAIT_MAX_MS} (wait)`,
		}),
	),
	sinceBytes: Type.Optional(
		Type.Number({
			description:
				"Only return output written after this byte offset — take it from a previous read/wait result (wait)",
		}),
	),
});

export type BgInput = Static<typeof bgSchema>;

/** Per-action inputs: validateAction guarantees the required fields before the cast. */
export type BgCreateInput = BgInput & { action: "create"; command: string };
export type BgReadInput = BgInput & { action: "read"; taskId: string };
export type BgWaitInput = BgInput & { action: "wait"; taskId: string };
export type BgKillInput = BgInput & { action: "kill"; taskId: string };

export interface BgCreateDetails {
	action: "create";
	taskId: string;
	outputPath: string;
	command: string;
	description?: string;
}

export interface BgReadDetails {
	action: "read";
	taskId: string;
	mode: "head" | "tail";
	sliceBytes: number;
	totalBytes: number;
	outputPath: string;
}

export interface BgWaitDetails {
	action: "wait";
	taskId: string;
	/** True when the wait window expired and the task is still running. */
	timedOut: boolean;
	status: BgTaskStatus;
	exitCode: number | null | undefined;
	waitedMs: number;
	deltaBytes: number;
	totalBytes: number;
	deltaTruncated: boolean;
	outputPath: string;
}

export interface BgKillDetails {
	action: "kill";
	taskId: string;
	command: string;
}

export interface BgListDetails {
	action: "list";
	running: number;
	finished: number;
	shown: number;
	hidden: number;
}

export type BgDetails = BgCreateDetails | BgReadDetails | BgWaitDetails | BgKillDetails | BgListDetails;

export interface BgNotificationDetails {
	taskId: string;
	command: string;
	description?: string;
	status: BgTaskStatus;
	/** True for the one-shot "waiting for interactive input" signal; the task keeps running. */
	stalled?: true;
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

/**
 * Strip characters XML 1.0 forbids: C0 controls (except \t \n \r), lone
 * surrogates (U+D800–U+DFFF), and the non-characters U+FFFE/U+FFFF.
 * sanitizeBinaryOutput does not remove the latter two classes, so this filter
 * is the authority for every text field in the notification XML.
 */
export function filterXmlCharacters(text: string): string {
	let result = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0d ||
			(code >= 0x20 && code <= 0xd7ff) ||
			(code >= 0xe000 && code <= 0xfffd) ||
			code >= 0x10000
		) {
			result += char;
		}
	}
	return result;
}

export function buildNotificationContent(notification: BgTaskNotification): string {
	const task = notification.task;
	const runtime = formatDuration((task.endedAt ?? task.startedAt) - task.startedAt);
	const exitCode = task.exitCode === undefined || task.exitCode === null ? "" : ` exitCode="${task.exitCode}"`;
	// filterXmlCharacters keeps \t \n \r and every other XML-legal codepoint,
	// so each field below is valid XML 1.0 after escaping.
	const xmlText = (text: string) => escapeXml(filterXmlCharacters(text));
	const lines = [
		`<background-task id="${task.id}" status="${task.status}"${exitCode} runtime="${runtime}">`,
		`<command>${xmlText(task.command)}</command>`,
	];
	if (task.description) {
		lines.push(`<description>${xmlText(task.description)}</description>`);
	}
	lines.push(`<output-file>${xmlText(task.outputPath)}</output-file>`);
	if (task.error) {
		lines.push(`<error>${xmlText(task.error)}</error>`);
	}
	if (notification.tailError) {
		lines.push(`<output-tail unavailable="${xmlText(notification.tailError)}"/>`);
	} else {
		const attrs = [
			`bytes="${notification.tailBytes}"`,
			`totalBytes="${notification.totalBytes}"`,
			notification.tailTruncated ? 'truncated="true"' : "",
			notification.tailStartsMidLine ? 'startsMidLine="true"' : "",
		]
			.filter(Boolean)
			.join(" ");
		const tail = notification.tailText.length > 0 ? xmlText(notification.tailText) : "(no output)";
		lines.push(`<output-tail ${attrs}>`, tail.trimEnd(), "</output-tail>");
	}
	lines.push("</background-task>");
	return lines.join("\n");
}

export function formatStatusline(counts: { running: number; total: number; stalled?: number }): string | undefined {
	if (counts.total === 0) return undefined;
	// Stalled tasks are running tasks: report them separately so the counts add up.
	const waiting = counts.stalled ?? 0;
	const running = counts.running - waiting;
	const ended = counts.total - counts.running;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (waiting > 0) parts.push(`${waiting} waiting for input`);
	if (ended > 0) parts.push(`${ended} done`);
	return `bg ${parts.join(" · ")}`;
}

export function buildStallContent(notification: BgStallNotification): string {
	const task = notification.task;
	const runtime = formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
	const xmlText = (text: string) => escapeXml(filterXmlCharacters(text));
	const lines = [
		`<background-task id="${task.id}" status="running" waiting-for-input="true" runtime="${runtime}">`,
		`<command>${xmlText(task.command)}</command>`,
	];
	if (task.description) {
		lines.push(`<description>${xmlText(task.description)}</description>`);
	}
	lines.push(`<output-file>${xmlText(task.outputPath)}</output-file>`);
	if (notification.tailError) {
		lines.push(`<output-tail unavailable="${xmlText(notification.tailError)}"/>`);
	} else {
		const attrs = [
			`bytes="${notification.tailBytes}"`,
			`totalBytes="${notification.totalBytes}"`,
			notification.tailTruncated ? 'truncated="true"' : "",
			notification.tailStartsMidLine ? 'startsMidLine="true"' : "",
		]
			.filter(Boolean)
			.join(" ");
		const tail = notification.tailText.length > 0 ? xmlText(notification.tailText) : "(no output)";
		lines.push(`<output-tail ${attrs}>`, tail.trimEnd(), "</output-tail>");
	}
	lines.push(
		"<advice>The command appears blocked waiting for interactive input. Kill it (bg action kill) and " +
			"re-run with piped input (e.g. echo y | command) or a non-interactive flag if one exists (e.g. --yes). " +
			"The task keeps running until then.</advice>",
	);
	lines.push("</background-task>");
	return lines.join("\n");
}

function toStallDetails(notification: BgStallNotification): BgNotificationDetails {
	const task = notification.task;
	return {
		taskId: task.id,
		command: task.command,
		description: task.description,
		status: "running",
		stalled: true,
		exitCode: undefined,
		runtimeMs: Date.now() - task.startedAt,
		outputPath: task.outputPath,
		totalBytes: notification.totalBytes,
		tailText: notification.tailText,
		tailTruncated: notification.tailTruncated,
		tailError: notification.tailError,
	};
}

function describeResolveFailure(input: string, result: ResolveTaskResult & { ok: false }): string {
	if (result.reason === "ambiguous") {
		const lines = result.candidates.map(
			(task) => `  ${task.id} (${task.status})  ${commandLabel(taskLabel(task), 60)}`,
		);
		return `Task id "${input}" is ambiguous. Candidates:\n${lines.join("\n")}`;
	}
	return `No background task matches "${input}". Check the id returned by bg (action create), or run action list.`;
}

/** One row of a bounded task listing: the model-facing list and /bg summaries. */
function describeTaskLine(task: BgTask, now: number): string {
	const duration = formatDuration((task.endedAt ?? now) - task.startedAt);
	const exit = task.exitCode !== undefined && task.exitCode !== null ? ` exit ${task.exitCode}` : "";
	return `  ${task.id}  ${task.status}${exit}  ${duration}  ${commandLabel(taskLabel(task), 60)}`;
}

/** Label for listings: the model-provided description over the first command line. */
function taskLabel(task: BgTask): string {
	return task.description ? `${task.description} — ${firstCommandLine(task.command)}` : firstCommandLine(task.command);
}

function toNotificationDetails(notification: BgTaskNotification): BgNotificationDetails {
	const task = notification.task;
	return {
		taskId: task.id,
		command: task.command,
		description: task.description,
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

export interface BackgroundExtensionOverrides {
	operations?: BashOperations;
	outputDir?: string;
	maxOutputBytes?: number;
	/** Stall watchdog tuning; defaults follow Claude Code's CC-1175 (5s/45s/1KB). */
	stall?: { pollIntervalMs?: number; thresholdMs?: number; tailBytes?: number };
}

/** Shell configuration for one bg session: the session's settings win, disk settings are the fallback. */
export function resolveSessionShell(
	ctx: ExtensionContext,
	readDiskSettings?: () => { shellPath?: string; commandPrefix?: string },
): { shellPath?: string; commandPrefix?: string } {
	return ctx.getShellSettings?.() ?? readDiskSettings?.() ?? {};
}

/** Local shell operations honoring the session's shell settings (shellPath, commandPrefix). */
function createSessionBashOperations(ctx: ExtensionContext): BashOperations {
	const shell = resolveSessionShell(ctx, () => {
		// Hosts without getShellSettings (older SDK hosts): fall back to reading
		// settings from disk, matching what the session was configured with.
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		return { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
	});
	return prependCommandPrefix(createLocalBashOperations({ shellPath: shell.shellPath }), shell.commandPrefix);
}

/** Validate per-action required fields; every message names the next step. */
function validateAction(input: BgInput): void {
	switch (input.action) {
		case "create":
			if (!input.command || input.command.trim().length === 0) {
				throw new Error("action 'create' requires 'command' — pass the bash command to run in the background.");
			}
			break;
		case "read":
		case "wait":
		case "kill":
			if (!input.taskId || input.taskId.trim().length === 0) {
				throw new Error(
					`action '${input.action}' requires 'taskId' — use the id returned by action create, or action list to find it.`,
				);
			}
			break;
		case "list":
			break;
	}
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
				onStall: (notification) => {
					// Informational one-shot signal: not a terminal state, so it bypasses
					// the claim protocol (a waiting model needs to know it is blocked on
					// input, not merely slow).
					pi.sendMessage(
						{
							customType: BG_NOTIFICATION_TYPE,
							content: buildStallContent(notification),
							display: true,
							details: toStallDetails(notification),
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

		const runCreate = async (
			params: BgCreateInput,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<BgCreateDetails>> => {
			if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0)) {
				throw new Error("Invalid timeout: must be a positive number of seconds.");
			}
			if (params.timeout !== undefined && params.timeout > MAX_TIMEOUT_SECONDS) {
				throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
			}
			// Same PI_* session variables as the built-in bash tool, snapshotted at start.
			const spawnContext = resolveSpawnContext(params.command, ctx.cwd, undefined, true, ctx);
			// Deliberately ignore the turn signal: aborting the current turn must
			// not kill the background task (that is what action kill is for).
			const task = requireRegistry().startTask({
				command: params.command,
				cwd: ctx.cwd,
				description: params.description,
				timeoutSeconds: params.timeout,
				env: spawnContext.env,
			});
			const label = task.description ? ` (${task.description})` : "";
			const text = [
				`Started background task ${task.id}${label}.`,
				`Output file: ${task.outputPath}`,
				"",
				"A <background-task> notification with the result and output tail arrives automatically when the task " +
					"ends — do NOT poll (no sleep loops, no repeated reads). Use action read for an early peek, " +
					"action wait when the next step depends on the result, action kill to stop it.",
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					action: "create",
					taskId: task.id,
					outputPath: task.outputPath,
					command: params.command,
					description: params.description,
				},
			};
		};

		const runRead = async (params: BgReadInput): Promise<AgentToolResult<BgReadDetails>> => {
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
			const running = task.status === "running" ? ["still running"] : [];
			const noticeParts = slice.truncated
				? [
						`${mode} ${formatSize(slice.sliceBytes)} of ${formatSize(slice.totalBytes)}`,
						`task ${task.id} ${task.status}`,
						...running,
						...(slice.startsMidLine ? ["first line may be partial"] : []),
						`full output: ${task.outputPath}`,
					]
				: [
						`task ${task.id} ${task.status}`,
						...running,
						`${formatSize(slice.totalBytes)} total`,
						`output: ${task.outputPath}`,
					];
			const body = text.length > 0 ? text : "(no output yet)";
			return {
				content: [{ type: "text", text: `[${noticeParts.join(" · ")}]\n${body}` }],
				details: {
					action: "read",
					taskId: task.id,
					mode,
					sliceBytes: slice.sliceBytes,
					totalBytes: slice.totalBytes,
					outputPath: task.outputPath,
				},
			};
		};

		const runWait = async (params: BgWaitInput): Promise<AgentToolResult<BgWaitDetails>> => {
			const task = resolveTaskOrThrow(params.taskId);
			const waitMs = Math.min(
				BG_WAIT_MAX_MS,
				Math.max(BG_WAIT_MIN_MS, Math.floor(params.waitMs ?? BG_WAIT_DEFAULT_MS)),
			);
			const startedWait = Date.now();
			const result = await requireRegistry().waitForResult(task.id, waitMs);
			const waitedMs = Date.now() - startedWait;
			const finalTask = result.task;
			const exitSuffix =
				finalTask.exitCode !== undefined && finalTask.exitCode !== null ? ` · exit ${finalTask.exitCode}` : "";
			const ran = formatDuration((finalTask.endedAt ?? Date.now()) - finalTask.startedAt);

			if (result.outcome === "timeout") {
				// Still running: keep progress visible with a bounded tail peek.
				let peekText = "";
				let peekNote = "";
				let totalBytes = finalTask.outputBytes;
				try {
					const peek = await readOutputSlice(finalTask.outputPath, { mode: "tail", maxBytes: BG_WAIT_PEEK_BYTES });
					peekText = sanitizeBinaryOutput(peek.text);
					totalBytes = peek.totalBytes;
					peekNote = peek.truncated ? ` (last ${formatSize(peek.sliceBytes)})` : "";
				} catch {
					peekNote = " (output unavailable)";
				}
				const lines = [
					`[${finalTask.id} still running · waited ${formatDuration(waitedMs)} · ${formatSize(totalBytes)} total]`,
				];
				const trimmed = peekText.trimEnd();
				if (trimmed.length > 0) lines.push(`Last output${peekNote}:\n${trimmed}`);
				lines.push(
					"The task keeps running. Wait again (action wait), peek with action read, or stop it with action kill; " +
						"the <background-task> notification still arrives when it ends. Do not sleep-poll.",
				);
				return {
					content: [{ type: "text", text: lines.join("\n\n") }],
					details: {
						action: "wait",
						taskId: finalTask.id,
						timedOut: true,
						status: finalTask.status,
						exitCode: finalTask.exitCode,
						waitedMs,
						deltaBytes: 0,
						totalBytes,
						deltaTruncated: false,
						outputPath: finalTask.outputPath,
					},
				};
			}

			// Terminal: deliver the bounded delta since the requested offset.
			// The followUp notification was suppressed by the claim protocol —
			// this result is the single delivery of the completion.
			const since = params.sinceBytes !== undefined ? Math.max(0, Math.floor(params.sinceBytes)) : undefined;
			let delta: Awaited<ReturnType<typeof readOutputSince>>;
			let offsetNote: string | undefined;
			try {
				delta = await readOutputSince(finalTask.outputPath, since ?? 0, BG_WAIT_DELTA_BYTES);
				if (since !== undefined && since > delta.totalBytes) {
					// A stale offset past EOF (the output was truncated at the cap, or
					// the model is reusing an id from an earlier read): fall back to
					// the tail and say so. Never an error — the offset is not a bug.
					delta = await readOutputSince(finalTask.outputPath, 0, BG_WAIT_DELTA_BYTES);
					offsetNote = finalTask.outputTruncated
						? "the given offset is past EOF — output was truncated at the limit; showing the tail"
						: "the given offset is past EOF; showing the tail";
				}
			} catch (error) {
				// Deliver the terminal status even when the output file cannot be read.
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `[${finalTask.id} ${finalTask.status}${exitSuffix} · ran ${ran} · waited ${formatDuration(waitedMs)}]\nerror reading output: ${message}`,
						},
					],
					details: {
						action: "wait",
						taskId: finalTask.id,
						timedOut: false,
						status: finalTask.status,
						exitCode: finalTask.exitCode,
						waitedMs,
						deltaBytes: 0,
						totalBytes: finalTask.outputBytes,
						deltaTruncated: false,
						outputPath: finalTask.outputPath,
					},
				};
			}

			const lines = [
				`[${finalTask.id} ${finalTask.status}${exitSuffix} · ran ${ran} · waited ${formatDuration(waitedMs)} · +${formatSize(delta.sliceBytes)} new output · total ${formatSize(delta.totalBytes)}]`,
			];
			if (offsetNote) lines.push(`[${offsetNote}]`);
			if (finalTask.error) lines.push(`error: ${finalTask.error}`);
			if (delta.truncated) {
				lines.push(
					`[showing ${formatSize(delta.sliceBytes)} of ${formatSize(delta.totalBytes)}; full output: ${finalTask.outputPath}]`,
				);
			}
			const body = sanitizeBinaryOutput(delta.text).trimEnd();
			lines.push(body.length > 0 ? body : "(no new output)");
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action: "wait",
					taskId: finalTask.id,
					timedOut: false,
					status: finalTask.status,
					exitCode: finalTask.exitCode,
					waitedMs,
					deltaBytes: delta.sliceBytes,
					totalBytes: delta.totalBytes,
					deltaTruncated: delta.truncated,
					outputPath: finalTask.outputPath,
				},
			};
		};

		const runKill = (params: BgKillInput): AgentToolResult<BgKillDetails> => {
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
						text: `Killed task ${task.id}. If you are waiting on it (action wait) the killed status is delivered there; otherwise a completion notification follows once the process tree is reaped.`,
					},
				],
				details: { action: "kill", taskId: task.id, command: task.command },
			};
		};

		const runList = (): AgentToolResult<BgListDetails> => {
			const tasks = requireRegistry().listTasks();
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No background tasks this session. Start one with action create." }],
					details: { action: "list", running: 0, finished: 0, shown: 0, hidden: 0 },
				};
			}
			const now = Date.now();
			const running = tasks.filter((task) => task.status === "running");
			const finished = tasks.filter((task) => task.status !== "running");
			const shownFinished = finished.slice(0, BG_LIST_FINISHED_SHOWN);
			const hidden = finished.length - shownFinished.length;
			const lines = [`${running.length} running · ${finished.length} finished`];
			for (const task of [...running, ...shownFinished]) {
				lines.push(describeTaskLine(task, now));
			}
			if (hidden > 0) {
				lines.push(`(+${hidden} more finished, not shown — action read shows any task's output)`);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					action: "list",
					running: running.length,
					finished: finished.length,
					shown: running.length + shownFinished.length,
					hidden,
				},
			};
		};

		pi.registerTool<typeof bgSchema, BgDetails>({
			name: "bg",
			label: "bg",
			description:
				"Run and manage background bash tasks.\n\n" +
				"create: start a command in the background and return immediately with a task id and an " +
				"output file path. Only use this when you don't need the result immediately and are OK being " +
				"notified when the command completes later — a <background-task> notification with status, exit " +
				"code, and output tail arrives automatically when it ends. Do NOT append '&' to the command; bg " +
				"already runs it detached. An optional description labels the task in the UI; an optional timeout " +
				"in seconds kills the task on expiry.\n\n" +
				"read: bounded slice of a task's output (default: last 8KB); works while the task runs. The " +
				"output file is a plain file — the read tool also works on it for line-based paging.\n\n" +
				"wait: block until a task finishes (default 20s, max 60s) and return its status plus output " +
				"written since a given offset. Use when the next step depends on the result; on timeout the task " +
				"is still running and you may wait again. Never emulate waiting with sleep.\n\n" +
				"kill: stop a running task (whole process tree).\n\n" +
				"list: currently known tasks with status.\n\n" +
				"Task ids accept a unique prefix ('3f' for 'bg-3f').",
			promptSnippet: "Manage background shell tasks (bg: create/read/wait/kill/list)",
			promptGuidelines: [
				"Use bg (action create) for long-running commands (dev servers, watch builds, slow tests) instead of regular bash; results arrive as an automatic <background-task> notification, so continue independent work or end the turn.",
				"Never wait on background tasks with sleep loops or repeated reads; use bg action wait (bounded) when a step depends on a task's result, or rely on the completion notification.",
			],
			parameters: bgSchema,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<BgDetails>> {
				validateAction(params);
				switch (params.action) {
					case "create":
						return runCreate(params as BgCreateInput, ctx);
					case "read":
						return runRead(params as BgReadInput);
					case "wait":
						return runWait(params as BgWaitInput);
					case "kill":
						return runKill(params as BgKillInput);
					case "list":
						return runList();
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
					const lines = active
						.listTasks()
						.slice(0, 10)
						.map((task) => describeTaskLine(task, Date.now()));
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
