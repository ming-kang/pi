import { unlink } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { boundText } from "../tasks/output.ts";
import type { TaskCompletion, TaskControl } from "../tasks/types.ts";
import type { BashOperations, BashSpawnContext } from "./bash.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS } from "./renderers/bash.ts";
import type { BashToolDetails } from "./shell-tool.ts";
import { formatSize } from "./truncate.ts";

export const MAX_BACKGROUND_OUTPUT_BYTES = 20 * 1024 * 1024;

interface ShellExecutionOptions {
	operations: BashOperations;
	context: BashSpawnContext;
	tempFilePrefix: string;
	timeout?: number;
	/** The task this command runs as; its signal cancels the process. */
	control: TaskControl<BashToolDetails | undefined>;
	/**
	 * The command belongs to a session task, which may leave the foreground: its output log is
	 * created and attached to the task from the first byte, and a final snapshot is always
	 * published. Otherwise the log is created only if output is truncated.
	 */
	taskLog: boolean;
}

interface ShellFailure {
	status: "failed" | "cancelled" | "timeout";
	error: string;
}

/** Interpret the documented BashOperations error markers once, before formatting output. */
function shellFailure(error: unknown): ShellFailure {
	if (error instanceof Error && error.message === "aborted") return { status: "cancelled", error: "Command aborted" };
	if (error instanceof Error && error.message.startsWith("timeout:"))
		return { status: "timeout", error: `Command timed out after ${error.message.split(":")[1]} seconds` };
	return { status: "failed", error: boundText(error instanceof Error ? error.message : String(error), 4096) };
}

function formatOutput(
	output: OutputAccumulator,
	snapshot: OutputSnapshot,
	taskLog: boolean,
	emptyText: string,
): { text: string; details: BashToolDetails | undefined } {
	const truncation = snapshot.truncation;
	let text = snapshot.content || emptyText;
	let details: BashToolDetails | undefined = taskLog ? { fullOutputPath: snapshot.fullOutputPath } : undefined;
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
}

/** One process and one output owner across foreground/background handoff. */
export async function runShellCommand(
	options: ShellExecutionOptions,
): Promise<TaskCompletion<BashToolDetails | undefined>> {
	const { operations, context, control, taskLog, timeout } = options;
	const signal = control.signal;
	const output = new OutputAccumulator({ tempFilePrefix: options.tempFilePrefix, persistFromStart: taskLog });
	const startedAt = performance.now();
	let outputError: Error | undefined;
	let acceptingOutput = true;
	let unsubscribe: (() => void) | undefined;
	let updateTimer: NodeJS.Timeout | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;

	const failOutput = (error: unknown) => {
		if (outputError) return;
		outputError = error instanceof Error ? error : new Error(String(error));
		try {
			control.cancel();
		} catch {
			// Late data must not throw through a process observer.
		}
	};
	const checkOutputLimit = () => {
		if (control.mode === "background" && output.getTotalBytes() > MAX_BACKGROUND_OUTPUT_BYTES) {
			failOutput(new Error("Background command exceeded the 20 MiB output limit"));
		}
	};
	const snapshot = () =>
		output.snapshot({
			persistIfTruncated: true,
			maxBytes: control.mode === "background" ? 40 * 1024 : undefined,
		});
	const publish = (snapshot?: OutputSnapshot) => {
		const result: AgentToolResult<BashToolDetails | undefined> = {
			content: snapshot ? [{ type: "text", text: snapshot.content }] : [],
			details: snapshot
				? {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					}
				: undefined,
		};
		control.publish({ result });
	};
	const emitOutputUpdate = () => {
		if (!updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		publish(snapshot());
	};
	const clearUpdateTimer = () => {
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
	};
	const scheduleOutputUpdate = () => {
		updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitOutputUpdate();
		} else {
			updateTimer ??= setTimeout(() => {
				updateTimer = undefined;
				emitOutputUpdate();
			}, delay);
		}
	};
	const handleData = (data: Buffer) => {
		if (!acceptingOutput || outputError) return;
		try {
			if (control.mode === "background" && output.getTotalBytes() + data.length > MAX_BACKGROUND_OUTPUT_BYTES) {
				const remaining = Math.max(0, MAX_BACKGROUND_OUTPUT_BYTES - output.getTotalBytes());
				output.append(data.subarray(0, remaining));
				failOutput(new Error("Background command exceeded the 20 MiB output limit"));
			} else output.append(data);
			scheduleOutputUpdate();
		} catch (error) {
			failOutput(error);
		}
	};

	try {
		if (taskLog) {
			const path = output.snapshot().fullOutputPath!;
			const cleanup = async () => {
				await output.closeTempFile();
				await unlink(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			};
			try {
				control.attachOutput(path, cleanup);
			} catch (error) {
				await cleanup();
				throw error;
			}
		}
		// Detach must check a silent foreground log too, preserving bytes already written.
		unsubscribe = control.onModeChange(checkOutputLimit);
		publish();
		let failure: ShellFailure | undefined;
		let exitCode: number | null | undefined;
		try {
			if (signal?.aborted) throw new Error("aborted");
			const execution = operations.exec(context.command, context.cwd, {
				onData: handleData,
				signal,
				timeout,
				env: context.env,
			});
			control.accept();
			({ exitCode } = await execution);
			if (exitCode === null) {
				failure = { status: "failed", error: "Command terminated without an exit code" };
			} else if (exitCode !== 0) {
				failure = { status: "failed", error: `Command exited with code ${exitCode}` };
			}
		} catch (error) {
			failure = shellFailure(error);
		}
		acceptingOutput = false;
		output.finish();
		clearUpdateTimer();
		if (taskLog) publish(snapshot());
		else emitOutputUpdate();
		const final = snapshot();
		await output.closeTempFile();
		// Final progress/cleanup can re-enter handoff. Classify policy cancellation
		// after those callbacks, independently of the process's abort marker.
		if (outputError) failure = { status: "failed", error: boundText(outputError.message, 4096) };
		const { text, details } = formatOutput(output, final, taskLog, failure ? "" : "(no output)");
		const fullOutput =
			typeof exitCode === "number" && !outputError ? await output.readFullOutput(1024 * 1024) : undefined;
		return {
			status: failure?.status,
			error: failure?.error,
			...(exitCode !== undefined ? { facts: [["Exit", exitCode === null ? "signal" : String(exitCode)]] } : {}),
			result: {
				...(fullOutput && typeof exitCode === "number"
					? {
							structuredContent: {
								output: fullOutput.content,
								truncated: fullOutput.truncated,
								...(fullOutput.truncated && final.fullOutputPath
									? { full_output_path: final.fullOutputPath }
									: {}),
								exit_code: exitCode,
								wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
							},
							...(failure ? { isError: true } : {}),
						}
					: {}),
				content: [{ type: "text", text: failure ? `${text ? `${text}\n\n` : ""}${failure.error}` : text }],
				details,
			},
		};
	} finally {
		acceptingOutput = false;
		unsubscribe?.();
		clearUpdateTimer();
		await output.closeTempFile();
	}
}
