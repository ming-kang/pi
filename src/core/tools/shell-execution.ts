import { unlink } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { boundText } from "../background/output.ts";
import type { BackgroundCompletion, BackgroundContext, BackgroundControl } from "../background/types.ts";
import type { BashOperations, BashSpawnContext, BashToolDetails } from "./bash.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS } from "./renderers/bash.ts";
import { formatSize, truncateTail } from "./truncate.ts";

export const MAX_BACKGROUND_OUTPUT_BYTES = 20 * 1024 * 1024;

export interface ManagedShellExecution {
	host: BackgroundContext;
	control: BackgroundControl<BashToolDetails | undefined>;
}

interface ShellExecutionOptions {
	operations: BashOperations;
	shellName: string;
	context: BashSpawnContext;
	tempFilePrefix: string;
	timeout?: number;
	signal?: AbortSignal;
	onUpdate?: (result: AgentToolResult<BashToolDetails | undefined>) => void;
	managed?: ManagedShellExecution;
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
	managed: boolean,
	emptyText: string,
): { text: string; details: BashToolDetails | undefined } {
	const truncation = snapshot.truncation;
	let text = snapshot.content || emptyText;
	let details: BashToolDetails | undefined = managed ? { fullOutputPath: snapshot.fullOutputPath } : undefined;
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
): Promise<BackgroundCompletion<BashToolDetails | undefined>> {
	const { operations, context, managed, signal, timeout } = options;
	const output = new OutputAccumulator({ tempFilePrefix: options.tempFilePrefix, persistFromStart: !!managed });
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
			if (managed) managed.host.kill(managed.control.id);
		} catch {
			// Late data must not throw through a process observer.
		}
	};
	const checkOutputLimit = () => {
		if (managed?.control.mode === "background" && output.getTotalBytes() > MAX_BACKGROUND_OUTPUT_BYTES) {
			failOutput(new Error("Background command exceeded the 20 MiB output limit"));
		}
	};
	const snapshot = () =>
		output.snapshot({
			persistIfTruncated: true,
			maxBytes: managed?.control.mode === "background" ? 40 * 1024 : undefined,
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
		if (managed) {
			managed.control.publish(result, {
				text: truncateTail(snapshot?.content ?? "", { maxBytes: 16 * 1024 }).content,
				shell: {
					name: options.shellName,
					output: { text: snapshot?.content ?? "", truncated: snapshot?.truncation.truncated ?? false },
				},
			});
		} else options.onUpdate?.(result);
	};
	const emitOutputUpdate = () => {
		if ((!managed && !options.onUpdate) || !updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		publish(snapshot());
	};
	const clearUpdateTimer = () => {
		if (updateTimer) clearTimeout(updateTimer);
		updateTimer = undefined;
	};
	const scheduleOutputUpdate = () => {
		if (!managed && !options.onUpdate) return;
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
			if (
				managed?.control.mode === "background" &&
				output.getTotalBytes() + data.length > MAX_BACKGROUND_OUTPUT_BYTES
			) {
				const remaining = Math.max(0, MAX_BACKGROUND_OUTPUT_BYTES - output.getTotalBytes());
				output.append(data.subarray(0, remaining));
				failOutput(new Error("Background command exceeded the 20 MiB output limit"));
			} else output.append(data);
			scheduleOutputUpdate();
		} catch (error) {
			if (!managed) throw error;
			failOutput(error);
		}
	};

	try {
		if (managed) {
			const path = output.snapshot().fullOutputPath!;
			const cleanup = async () => {
				await output.closeTempFile();
				await unlink(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			};
			try {
				managed.control.setOutputPath(path, cleanup);
			} catch (error) {
				await cleanup();
				throw error;
			}
			// Detach must check a silent foreground log too, preserving bytes already written.
			unsubscribe = managed.host.subscribe(checkOutputLimit);
		}
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
			managed?.control.accept();
			({ exitCode } = await execution);
			if (exitCode === null && managed) {
				failure = { status: "failed", error: "Command terminated without an exit code" };
			} else if (exitCode !== 0 && exitCode !== null) {
				failure = { status: "failed", error: `Command exited with code ${exitCode}` };
			}
		} catch (error) {
			failure = shellFailure(error);
		}
		acceptingOutput = false;
		output.finish();
		clearUpdateTimer();
		if (managed) publish(snapshot());
		else emitOutputUpdate();
		const final = snapshot();
		await output.closeTempFile();
		// Final progress/cleanup can re-enter handoff. Classify policy cancellation
		// after those callbacks, independently of the process's abort marker.
		if (outputError) failure = { status: "failed", error: boundText(outputError.message, 4096) };
		const { text, details } = formatOutput(output, final, !!managed, failure ? "" : "(no output)");
		return {
			status: failure?.status,
			error: failure?.error,
			...(exitCode !== undefined ? { exitCode } : {}),
			result: {
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
