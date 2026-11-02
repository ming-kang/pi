/**
 * The managed shell tools: the native shell definition (`bash.ts`) plus a `background` parameter,
 * adapted to the session's Tasks. The native body stays the one owner of execution, progress,
 * output formatting and results; outside a session it runs unchanged.
 */
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { TASKS_TOOL_NAME, type TaskCompletion, type TaskToolOutcome } from "../tasks/types.ts";
import {
	type BashOperations,
	type BashRenderState,
	type BashToolOptions,
	createShellToolDefinition as createNativeShellToolDefinition,
	type BashToolDetails as NativeBashToolDetails,
	bashOutputSchema as nativeOutputSchema,
	bashSchema as nativeSchema,
	type ShellToolConfig,
} from "./bash.ts";
import { runShellTask } from "./shell-execution.ts";
import { createLocalBashOperations } from "./shell-operations.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const bashSchema = Type.Object({
	...nativeSchema.properties,
	background: Type.Optional(
		Type.Boolean({
			description:
				"true returns a managed task ID immediately and runs the command in the background, and you are notified when it completes — do not poll for its result; omit or false to block until exit",
		}),
	),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands, foreground or background",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

const bashOutputSchema = Type.Union([
	nativeOutputSchema,
	Type.Object({ task_id: Type.String(), status: Type.String() }),
]);

export interface BashToolDetails extends NativeBashToolDetails {
	/** Settled handoff snapshot, not a command completion or exit code. */
	background?: { kind: "background"; taskId: string };
}

const BACKGROUND_GUIDANCE = `Choose the mode per call: foreground (default) blocks until the command exits — use it when your next step needs the output; background: true returns immediately with a task ID — use it for long-running work (builds, servers, watchers, big test suites) or when you have independent work to continue. A handoff is not completion: the result arrives later as an automatic completion notification; meanwhile use ${TASKS_TOOL_NAME} read to inspect output and ${TASKS_TOOL_NAME} kill to stop it. Background output is limited to 20 MiB.`;

/**
 * Translate terminal shell failures to the native foreground tool contract once. A task result
 * holds the command's output only; the foreground text is that output followed by the failure.
 */
function shellToolResult(completion: TaskCompletion<BashToolDetails | undefined>) {
	const status = completion.status;
	const output = completion.result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const withError = (error: string) => (output ? `${output}\n\n${error}` : error);
	if (completion.result.structuredContent) {
		if (!completion.result.isError || !completion.error) return completion.result;
		return { ...completion.result, content: [{ type: "text" as const, text: withError(completion.error) }] };
	}
	if (status === "failed" || status === "timeout" || status === "cancelled") {
		throw new Error(
			completion.error ? withError(completion.error) : `${output ? `${output}\n\n` : ""}Command ${status}`,
		);
	}
	return completion.result;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options: BashToolOptions & { operations: BashOperations },
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const native = createNativeShellToolDefinition(cwd, config, options);
	return {
		...native,
		description: `${native.description} ${BACKGROUND_GUIDANCE}`,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		async execute(toolCallId, { command, timeout, background }: BashToolInput, parentSignal, onUpdate, ctx) {
			const tasks = ctx?.tasks;
			if (!tasks) {
				if (background)
					throw new Error("Background execution is not available in this host. No command was started.");
				return native.execute(toolCallId, { command, timeout }, parentSignal, onUpdate, ctx);
			}
			if (tasks.closed) throw new Error("Task service is closed");
			const outcome: TaskToolOutcome<BashToolDetails | undefined> = await tasks.execute<BashToolDetails | undefined>(
				{
					kind: config.name,
					label: config.shellName[0]!.toUpperCase() + config.shellName.slice(1),
					title: command,
					input: { label: "Command", text: command, truncated: false, language: config.name },
					facts: [["Directory", ctx.cwd || cwd]],
					toolCallId,
					background,
					signal: parentSignal,
					onUpdate,
					// A setup throw settles the task as failed, or cancelled once its signal fired.
					run: (control) =>
						runShellTask({
							control,
							operations: options.operations,
							tempFilePrefix: config.tempFilePrefix,
							timeout,
							execute: (parts) =>
								createNativeShellToolDefinition(
									cwd,
									{ ...config, createOutput: parts.createOutput },
									{ ...options, operations: parts.operations },
								).execute(toolCallId, { command, timeout }, control.signal, parts.onUpdate, ctx),
						}),
				},
			);
			if (outcome.kind === "result") return shellToolResult(outcome);
			const tail = `Task ID: ${outcome.task.id}. Status: ${outcome.task.status}. Completion arrives and wakes you automatically — do not poll or wait on it; continue with other work, or end your turn and hand back to the user. If you would only wait for the result, prefer foreground next time. Use ${TASKS_TOOL_NAME} read to inspect output or ${TASKS_TOOL_NAME} kill to stop it.`;
			// Shell execution can become background work in two ways, and the model has to know which
			// one it got: a submitted background command starts from an empty log, while a detached
			// one already holds output and keeps its original timeout.
			const handoff =
				outcome.reason === "submitted"
					? `Command handed to background. ${tail}`
					: `Command moved to the background while it was running, by the user. The execution continues unchanged — no restart, and a supplied timeout is still measured from command startup. Output produced so far is already in the log, so ${TASKS_TOOL_NAME} read now returns partial output, not a fresh start. ${tail}`;
			return {
				structuredContent: { task_id: outcome.task.id, status: outcome.task.status },
				content: [
					{
						type: "text",
						text: `${handoff}${outcome.task.outputPath ? `\nFull output: ${outcome.task.outputPath}` : ""}`,
					},
				],
				details: {
					background: { kind: "background", taskId: outcome.task.id },
					fullOutputPath: outcome.task.outputPath,
				},
			};
		},
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ReturnType<typeof createShellToolDefinition> {
	return createShellToolDefinition(cwd, bashToolConfig, {
		...options,
		operations: options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath }),
	});
}

export function createBashTool(cwd: string, options?: BashToolOptions) {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
