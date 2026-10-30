import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { TaskCompletion } from "../tasks/types.ts";
import {
	type BashOperations,
	type BashToolOptions,
	resolveSpawnContext,
	resolveTimeoutMs,
	type ShellToolConfig,
} from "./bash.ts";
import { createShellRenderers } from "./renderers/bash.ts";
import { type ManagedShellExecution, runShellCommand } from "./shell-execution.ts";
import { createLocalBashOperations } from "./shell-operations.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "./truncate.ts";

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
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
	Type.Object({
		output: Type.String({
			description: "Combined stdout and stderr, up to 1 MiB, keeping head and tail when truncated.",
		}),
		truncated: Type.Boolean(),
		full_output_path: Type.Optional(Type.String()),
		exit_code: Type.Number(),
		wall_time_seconds: Type.Number(),
	}),
	Type.Object({ task_id: Type.String(), status: Type.String() }),
]);

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Settled handoff snapshot, not a command completion or exit code. */
	background?: { kind: "background"; taskId: string };
}

export type BashRenderState = {
	dispose?: () => void;
};

/** Translate terminal shell failures to the native foreground tool contract once. */
function shellToolResult(completion: TaskCompletion<BashToolDetails | undefined>) {
	const status = completion.status;
	if (completion.result.structuredContent) return completion.result;
	if (status === "failed" || status === "timeout" || status === "cancelled") {
		const text = completion.result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const message = completion.error ? text || completion.error : `${text ? `${text}\n\n` : ""}Command ${status}`;
		throw new Error(message);
	}
	return completion.result;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options: BashToolOptions & { operations: BashOperations },
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options.operations;
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a temp file. Optionally provide a timeout in seconds (no default). Choose the mode per call: foreground (default) blocks until the command exits — use it when your next step needs the output; background: true returns immediately with a task ID — use it for long-running work (builds, servers, watchers, big test suites) or when you have independent work to continue. A handoff is not completion: the result arrives later as an automatic completion notification; meanwhile use tasks read to inspect output, tasks wait with an ID for one task or without one for any running task, and tasks kill to stop it. Steering interrupts only a wait, never execution. Background output is limited to 20 MiB; an expired tasks wait window never stops the command.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			toolCallId,
			{ command, timeout, background }: BashToolInput,
			parentSignal?: AbortSignal,
			originalUpdate?,
			ctx?: ExtensionContext,
		) {
			const host = ctx?.tasks;
			if (host?.closed) throw new Error("Task service is closed");
			const run = async (managed?: ManagedShellExecution): Promise<TaskCompletion<BashToolDetails | undefined>> => {
				const signal = managed?.control.signal ?? parentSignal;
				if (managed) {
					if (signal?.aborted) throw new Error("Command aborted");
					resolveTimeoutMs(timeout);
				}
				const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
				const spawnContext = resolveSpawnContext(
					resolvedCommand,
					ctx?.cwd || cwd,
					spawnHook,
					exposeSessionEnvironment,
					ctx,
				);
				// A setup throw settles a managed task as failed, or cancelled once its signal fired.
				return await runShellCommand({
					operations: ops,
					context: spawnContext,
					tempFilePrefix: config.tempFilePrefix,
					timeout,
					signal,
					onUpdate: originalUpdate,
					managed,
				});
			};
			if (!host) {
				if (background)
					throw new Error("Background execution is not available in this host. No command was started.");
				return shellToolResult(await run());
			}
			const outcome = await host.execute<BashToolDetails | undefined>({
				kind: config.name,
				label: config.shellName[0]!.toUpperCase() + config.shellName.slice(1),
				title: command,
				input: { label: "Command", text: command, truncated: false, language: config.name },
				facts: [["Directory", ctx?.cwd || cwd]],
				toolCallId,
				background,
				signal: parentSignal,
				onUpdate: originalUpdate,
				run: (control) => run({ control }),
			});
			if (outcome.kind === "result") return shellToolResult(outcome);
			const tail = `Task ID: ${outcome.task.id}. Status: ${outcome.task.status}. Completion arrives automatically as a notification — do not poll or immediately wait on it; continue with other work or hand back to the user. Use tasks read to inspect output, tasks wait only when your next step is blocked on a result (one ID or any running task; prefer foreground next time in that case), or tasks kill to stop it.`;
			// Shell execution can become background work in two ways, and the model has to know which
			// one it got: a submitted background command starts from an empty log, while a detached
			// one already holds output and keeps its original timeout.
			const handoff =
				background === true
					? `Command handed to background. ${tail}`
					: `Command moved to the background while it was running, by the user. The execution continues unchanged — no restart, and a supplied timeout is still measured from command startup. Output produced so far is already in the log, so tasks read now returns partial output, not a fresh start. ${tail}`;
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
		...createShellRenderers(config),
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
