import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	rewriteCmdNulRedirects,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { type BackgroundCompletion, BackgroundExecutionError } from "../background/types.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { createShellRenderers } from "./renderers/bash.ts";
import { type ManagedShellExecution, runShellCommand } from "./shell-execution.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "./truncate.ts";

export { MAX_BACKGROUND_OUTPUT_BYTES } from "./shell-execution.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
export const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * The one timeout rule, shared by this tool and the background extension so a
 * rejected timeout reads the same wherever it is caught.
 */
export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	background: Type.Optional(
		Type.Boolean({
			description:
				"true returns a managed task ID immediately and runs the command in the background; omit or false to block until exit",
		}),
	),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands, foreground or background",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Settled handoff snapshot, not a command completion or exit code. */
	background?: { kind: "background"; taskId: string };
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 *
	 * Error contract: reject with `new Error("aborted")` when aborted via `signal`,
	 * and `new Error("timeout:<seconds>")` on timeout expiry — callers (including
	 * the background extension) classify outcomes from these exact markers.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(
	shellName: string,
	resolveShellConfig: () => ShellConfig,
	normalizeCommand: (command: string) => string = (command) => command,
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			if (signal?.aborted) throw new Error("aborted");
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const normalizedCommand = normalizeCommand(command);
			const child = spawn(
				shellConfig.shell,
				commandFromStdin ? shellConfig.args : [...shellConfig.args, normalizedCommand],
				{
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(normalizedCommand);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function normalizeLocalBashCommand(command: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? rewriteCmdNulRedirects(command) : command;
}

export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath), normalizeLocalBashCommand);
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

/** Translate terminal shell failures to the native foreground tool contract once. */
function shellToolResult(completion: BackgroundCompletion<BashToolDetails | undefined>, managed: boolean) {
	const status = completion.status;
	if (status === "failed" || status === "timeout" || status === "cancelled") {
		const text = completion.result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const message = completion.error ? text || completion.error : `${text ? `${text}\n\n` : ""}Command ${status}`;
		throw managed ? new BackgroundExecutionError(message, status) : new Error(message);
	}
	return completion.result;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); the full output is saved to a temp file. Optionally provide a timeout in seconds (no default). Choose the mode per call: foreground (default) blocks until the command exits — use it when your next step needs the output; background: true returns immediately with a task ID — use it for long-running work (builds, servers, watchers, big test suites) or when you have independent work to continue. A handoff is not completion: the result arrives later as an automatic completion notification; meanwhile use bg read to inspect output, bg wait to block until it settles, bg kill to stop it. Background output is limited to 20 MiB; an expired bg wait window never stops the command.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			toolCallId,
			{ command, timeout, background }: BashToolInput,
			parentSignal?: AbortSignal,
			originalUpdate?,
			ctx?: ExtensionContext,
		) {
			const host = ctx?.background;
			if (host?.closed) throw new Error("Background service is closed");
			const run = async (
				managed?: ManagedShellExecution,
			): Promise<BackgroundCompletion<BashToolDetails | undefined>> => {
				const signal = managed?.control.signal ?? parentSignal;
				try {
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
					return await runShellCommand({
						operations: ops,
						shellName: config.shellName,
						context: spawnContext,
						tempFilePrefix: config.tempFilePrefix,
						timeout,
						signal,
						onUpdate: originalUpdate,
						managed,
					});
				} catch (error) {
					// Setup and cleanup exceptions carry an explicit terminal status.
					if (!managed) throw error;
					throw new BackgroundExecutionError(
						error instanceof Error ? error.message : String(error),
						managed.control.signal.aborted ? "cancelled" : "failed",
					);
				}
			};
			if (!host || (!host.enabled && !background)) {
				if (background)
					throw new Error("Background execution is not available in this host. No command was started.");
				return shellToolResult(await run(), false);
			}
			const outcome = await host.execute<BashToolDetails | undefined>({
				kind: "bash",
				title: `${config.label}: ${command}`,
				toolCallId,
				command,
				cwd: ctx?.cwd || cwd,
				background,
				signal: parentSignal,
				onUpdate: originalUpdate,
				run: (control) => run({ host, control }),
			});
			if (outcome.kind === "result") return shellToolResult(outcome, true);
			return {
				content: [
					{
						type: "text",
						text: `Command handed to background. Task ID: ${outcome.task.id}. Status: ${outcome.task.status}. Its completion will be delivered automatically; use bg read to inspect output, bg wait to block until it settles, or bg kill to stop it.${outcome.task.outputPath ? `\nFull output: ${outcome.task.outputPath}` : ""}`,
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
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
