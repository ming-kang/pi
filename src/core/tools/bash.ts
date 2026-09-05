import { constants } from "node:fs";
import { access as fsAccess, unlink } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
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
import { boundText } from "../background/output.ts";
import {
	type BackgroundControl,
	BackgroundExecutionError,
	type BackgroundTerminalStatus,
} from "../background/types.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.ts";

export const MAX_BACKGROUND_OUTPUT_BYTES = 20 * 1024 * 1024;

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
		Type.Boolean({ description: "Run in the background (requires an enabled host; unavailable inside subagents)" }),
	),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
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
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. With an enabled host, background: true returns a managed task reference. Background output is limited to 20 MiB. Use background: true for long-running work, then use bg read/wait/kill with the returned task ID; a handoff is not completion. A bg wait window expiring does not stop the command. Inside subagents, omit background or use false; only the parent can background the whole invocation.`,
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
			if (background && !host) {
				throw new Error("Background execution is not available in this host. No command was started.");
			}
			let accepted = false;
			let failureStatus: BackgroundTerminalStatus = "failed";
			let terminalDiagnostic: string | undefined;
			let managedOutputPath: string | undefined;
			const run = async (
				control?: BackgroundControl<BashToolDetails | undefined>,
			): Promise<AgentToolResult<BashToolDetails | undefined>> => {
				const signal = control?.signal ?? parentSignal;
				const onUpdate = control
					? (result: AgentToolResult<BashToolDetails | undefined>) =>
							control.publish(result, {
								text: truncateTail(
									result.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("\n"),
									{ maxBytes: 16 * 1024 },
								).content,
							})
					: originalUpdate;
				if (control) {
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
				const output = new OutputAccumulator({
					tempFilePrefix: config.tempFilePrefix,
					persistFromStart: !!control,
				});
				let outputError: Error | undefined;
				const failOutput = (error: unknown) => {
					if (outputError) return;
					outputError = error instanceof Error ? error : new Error(String(error));
					try {
						host?.kill(control!.id);
					} catch {
						/* Late data must not throw through a process observer. */
					}
				};
				// Foreground has no disk cap. If its existing log already exceeds the
				// background budget, detach stops it immediately but preserves those prior bytes.
				const checkOutputLimit = () => {
					if (control?.mode === "background" && output.getTotalBytes() > MAX_BACKGROUND_OUTPUT_BYTES) {
						failOutput(new Error("Background command exceeded the 20 MiB output limit"));
					}
				};
				let unsubscribe: (() => void) | undefined;
				let acceptingOutput = true;
				let updateTimer: NodeJS.Timeout | undefined;
				let updateDirty = false;
				let lastUpdateAt = 0;

				const emitOutputUpdate = () => {
					if (!onUpdate || !updateDirty) return;
					updateDirty = false;
					lastUpdateAt = Date.now();
					const snapshot = output.snapshot({
						persistIfTruncated: true,
						maxBytes: control?.mode === "background" ? 40 * 1024 : undefined,
					});
					onUpdate({
						content: [{ type: "text", text: snapshot.content || "" }],
						details: {
							truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
							fullOutputPath: snapshot.fullOutputPath,
						},
					});
				};

				const clearUpdateTimer = () => {
					if (updateTimer) {
						clearTimeout(updateTimer);
						updateTimer = undefined;
					}
				};

				const scheduleOutputUpdate = () => {
					if (!onUpdate) return;
					updateDirty = true;
					const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
					if (delay <= 0) {
						clearUpdateTimer();
						emitOutputUpdate();
						return;
					}
					updateTimer ??= setTimeout(() => {
						updateTimer = undefined;
						emitOutputUpdate();
					}, delay);
				};

				const handleData = (data: Buffer) => {
					if (!acceptingOutput) return;
					if (outputError) return;
					try {
						if (
							control?.mode === "background" &&
							output.getTotalBytes() + data.length > MAX_BACKGROUND_OUTPUT_BYTES
						) {
							const remaining = Math.max(0, MAX_BACKGROUND_OUTPUT_BYTES - output.getTotalBytes());
							output.append(data.subarray(0, remaining));
							failOutput(new Error("Background command exceeded the 20 MiB output limit"));
						} else {
							output.append(data);
						}
						scheduleOutputUpdate();
					} catch (error) {
						if (!control) throw error;
						failOutput(error);
					}
				};

				const finishOutput = async () => {
					acceptingOutput = false;
					output.finish();
					clearUpdateTimer();
					emitOutputUpdate();
					const snapshot = output.snapshot({
						persistIfTruncated: true,
						maxBytes: control?.mode === "background" ? 40 * 1024 : undefined,
					});
					await output.closeTempFile();
					return snapshot;
				};

				const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
					const truncation = snapshot.truncation;
					let text = snapshot.content || emptyText;
					let details: BashToolDetails | undefined = control
						? { fullOutputPath: snapshot.fullOutputPath }
						: undefined;
					if (truncation.truncated) {
						details = { truncation, fullOutputPath: snapshot.fullOutputPath };
						const startLine = truncation.totalLines - truncation.outputLines + 1;
						const endLine = truncation.totalLines;
						if (truncation.lastLinePartial) {
							const lastLineSize = formatSize(output.getLastLineBytes());
							text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
						} else if (truncation.truncatedBy === "lines") {
							text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
						} else {
							text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${snapshot.fullOutputPath}]`;
						}
					}
					return { text, details };
				};

				const appendStatus = (text: string, status: string) => {
					// Store only the reason, never the accumulated stdout/stderr.
					terminalDiagnostic = boundText(status, 4096);
					return `${text ? `${text}\n\n` : ""}${status}`;
				};

				try {
					if (control) {
						const path = output.snapshot().fullOutputPath!;
						managedOutputPath = path;
						const cleanup = async () => {
							await output.closeTempFile();
							await unlink(path).catch((error: NodeJS.ErrnoException) => {
								if (error.code !== "ENOENT") throw error;
							});
						};
						try {
							control.setOutputPath(path, cleanup);
						} catch (error) {
							await cleanup();
							throw error;
						}
						unsubscribe = host?.subscribe(checkOutputLimit);
					}
					onUpdate?.({ content: [], details: undefined });
					let exitCode: number | null;
					try {
						if (signal?.aborted) throw new Error("aborted");
						const execution = ops.exec(spawnContext.command, spawnContext.cwd, {
							onData: handleData,
							signal,
							timeout,
							env: spawnContext.env,
						});
						accepted = true;
						control?.accept();
						const result = await execution;
						if (outputError) throw outputError;
						exitCode = result.exitCode;
					} catch (err) {
						const snapshot = await finishOutput();
						const { text } = formatOutput(snapshot, "");
						if (outputError) throw new Error(appendStatus(text, outputError.message));
						if (err instanceof Error && err.message === "aborted") {
							failureStatus = "cancelled";
							throw new Error(appendStatus(text, "Command aborted"));
						}
						if (err instanceof Error && err.message.startsWith("timeout:")) {
							failureStatus = "timeout";
							const timeoutSecs = err.message.split(":")[1];
							throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
						}
						throw new Error(appendStatus(text, err instanceof Error ? err.message : String(err)));
					}

					const snapshot = await finishOutput();
					const { text: outputText, details } = formatOutput(snapshot);
					if (control && exitCode === null) {
						throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
					}
					if (exitCode !== 0 && exitCode !== null) {
						throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
					}
					return { content: [{ type: "text", text: outputText }], details };
				} finally {
					acceptingOutput = false;
					unsubscribe?.();
					clearUpdateTimer();
					await output.closeTempFile();
				}
			};
			if (!host?.enabled && !background) return run();
			const outcome = await host!.execute<BashToolDetails | undefined>({
				kind: "bash",
				title: `${config.label}: ${command}`,
				toolCallId,
				command,
				cwd: ctx?.cwd || cwd,
				background,
				signal: parentSignal,
				onUpdate: originalUpdate,
				run: async (control) => {
					try {
						return { result: await run(control) };
					} catch (error) {
						// Foreground keeps the tool's throwing error contract. Background completion
						// carries an explicit status: output limits are failures, not cancellations.
						if (!accepted || control.mode === "foreground") {
							throw new BackgroundExecutionError(
								error instanceof Error ? error.message : String(error),
								!accepted && control.signal.aborted ? "cancelled" : failureStatus,
							);
						}
						return {
							status: failureStatus,
							error:
								terminalDiagnostic ?? boundText(error instanceof Error ? error.message : String(error), 4096),
							result: {
								content: [
									{
										type: "text",
										text: truncateTail(error instanceof Error ? error.message : String(error), {
											maxBytes: 40 * 1024,
										}).content,
									},
								],
								details: { fullOutputPath: managedOutputPath },
							},
						};
					}
				},
			});
			if (outcome.kind === "result") {
				if (outcome.status === "failed" || outcome.status === "timeout" || outcome.status === "cancelled") {
					throw new BackgroundExecutionError(outcome.error ?? `Command ${outcome.status}`, outcome.status);
				}
				return outcome.result;
			}
			return {
				content: [
					{
						type: "text",
						text: `Command handed to background. Task ID: ${outcome.task.id}. Status: ${outcome.task.status}. Use bg to read, wait, or stop it.${outcome.task.outputPath ? `\nFull output: ${outcome.task.outputPath}` : ""}`,
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
