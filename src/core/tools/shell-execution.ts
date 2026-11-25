/**
 * Runs the native shell tool body (`bash.ts`) as one session task. The native body owns the
 * process, progress, output formatting and structured result; this adapter only supplies the
 * task's output log, its background limits and acceptance, and translates the native outcome
 * into a task completion.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createOutputFilePath, type OutputFileResult, type OutputFileStream } from "../../utils/output-files.ts";
import type { TasksBackgroundOutputLimitAction } from "../settings-schema.ts";
import { boundText } from "../tasks/output.ts";
import type { TaskCompletion, TaskControl, TaskFact, TaskTerminalStatus } from "../tasks/types.ts";
import { type BashOperations, resolveTimeoutMs } from "./bash.ts";
import { OutputAccumulator, type OutputAccumulatorOptions, type OutputSnapshot } from "./output-accumulator.ts";
import type { BashToolDetails } from "./shell-tool.ts";
import { formatSize, truncateTail } from "./truncate.ts";

export const MAX_BACKGROUND_OUTPUT_BYTES = 20 * 1024 * 1024;
/** Background snapshots stay within the task result budget, so the bounded result keeps the newest output. */
const BACKGROUND_SNAPSHOT_BYTES = 40 * 1024;

function outputLimitError(maxBytes: number): string {
	return maxBytes === MAX_BACKGROUND_OUTPUT_BYTES
		? "Background command exceeded the 20 MiB output limit"
		: `Background command exceeded the ${formatSize(maxBytes)} output limit`;
}

type ShellDetails = BashToolDetails | undefined;
type ShellControl = TaskControl<ShellDetails>;

/**
 * Synchronous task log implementing upstream's `OutputFileStream`.
 *
 * Opened exclusively before spawn so the task has one continuously readable log from byte 0
 * without an unbounded async stream queue. Unlike upstream's unmanaged temp files, a partial log
 * stays on disk as a diagnostic artifact owned by task retention cleanup.
 */
export class ManagedOutputFile implements OutputFileStream {
	readonly path: string;
	writeError?: unknown;
	private fd: number | undefined;
	private currentResult: OutputFileResult;

	private constructor(path: string, fd: number) {
		this.path = path;
		this.fd = fd;
		this.currentResult = { kind: "saved", path };
	}

	static open(prefix: string): ManagedOutputFile {
		const path = createOutputFilePath(prefix, ".log");
		try {
			return new ManagedOutputFile(path, openSync(path, "wx", 0o600));
		} catch (error) {
			throw new Error(`Could not create the managed output file: ${errorMessage(error)}`);
		}
	}

	get result(): OutputFileResult {
		return this.currentResult;
	}

	write(data: string | Uint8Array): void {
		const fd = this.fd;
		if (fd === undefined) return;
		const bytes = typeof data === "string" ? Buffer.from(data) : data;
		try {
			let offset = 0;
			while (offset < bytes.length) {
				const written = writeSync(fd, bytes, offset, bytes.length - offset);
				if (written === 0) throw new Error("Output file write made no progress");
				offset += written;
			}
		} catch (error) {
			this.fd = undefined;
			try {
				closeSync(fd);
			} catch {
				// The write failure is the actionable error.
			}
			this.writeError ??= error;
			this.fail(error);
		}
	}

	/** Stop writing additional bytes to disk while keeping what was written. */
	stop(): void {
		this.closeFd();
	}

	async close(): Promise<OutputFileResult> {
		this.closeFd();
		return this.currentResult;
	}

	private closeFd(): void {
		const fd = this.fd;
		if (fd === undefined) return;
		this.fd = undefined;
		try {
			closeSync(fd);
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): void {
		if (this.currentResult.kind === "saved") {
			this.currentResult = { kind: "failed", error: errorMessage(error) };
		}
	}
}

/**
 * A session task's output: persisted from the first byte to the log attached to the task, and
 * bounded once the task is background work. In "fail" mode a write failure or the background cap
 * cancels the task instead of throwing through the process's data observer; in "truncate" mode
 * exceeding the cap stops disk logging while letting the command finish with its rolling tail.
 */
class TaskOutput extends OutputAccumulator {
	error?: Error;
	diskTruncated = false;
	readonly maxBackgroundOutputBytes: number;
	private readonly control: ShellControl;
	private readonly log: ManagedOutputFile;
	private readonly limitAction: TasksBackgroundOutputLimitAction;
	private totalBytes = 0;

	constructor(
		control: ShellControl,
		log: ManagedOutputFile,
		options: OutputAccumulatorOptions & {
			maxBackgroundOutputBytes?: number;
			backgroundOutputLimitAction?: TasksBackgroundOutputLimitAction;
		},
	) {
		super({ ...options, outputFile: log });
		this.control = control;
		this.log = log;
		this.maxBackgroundOutputBytes =
			options.maxBackgroundOutputBytes !== undefined &&
			Number.isFinite(options.maxBackgroundOutputBytes) &&
			options.maxBackgroundOutputBytes > 0
				? Math.floor(options.maxBackgroundOutputBytes)
				: MAX_BACKGROUND_OUTPUT_BYTES;
		this.limitAction = options.backgroundOutputLimitAction ?? "fail";
	}

	override append(data: Buffer): void {
		if (this.error) return;
		this.control.noteOutput();
		try {
			if (this.diskTruncated) {
				this.appendChunk(data);
				return;
			}
			const room = this.maxBackgroundOutputBytes - this.totalBytes;
			if (this.control.mode === "background" && data.length > room) {
				if (room > 0) this.appendChunk(data.subarray(0, room));
				if (this.error) return;
				if (this.limitAction === "truncate") {
					this.diskTruncated = true;
					this.log.stop();
					const remainder = data.subarray(Math.max(0, room));
					if (remainder.length > 0) this.appendChunk(remainder);
				} else {
					this.fail(new Error(outputLimitError(this.maxBackgroundOutputBytes)));
				}
			} else this.appendChunk(data);
		} catch (error) {
			this.fail(error);
		}
	}

	override snapshot(options: Parameters<OutputAccumulator["snapshot"]>[0] = {}): OutputSnapshot {
		const snapshot = super.snapshot(options);
		if (this.control.mode !== "background" || snapshot.truncation.outputBytes <= BACKGROUND_SNAPSHOT_BYTES) {
			return snapshot;
		}
		// A truncated snapshot was joined without a final newline; append one so trailing blank lines keep their count.
		const source = snapshot.truncation.truncated ? `${snapshot.content}\n` : snapshot.content;
		const tail = truncateTail(source, {
			maxLines: snapshot.truncation.maxLines,
			maxBytes: BACKGROUND_SNAPSHOT_BYTES,
		});
		return {
			...snapshot,
			content: tail.content,
			truncation: {
				...tail,
				truncated: true,
				truncatedBy: tail.truncatedBy ?? "bytes",
				totalLines: snapshot.truncation.totalLines,
				totalBytes: snapshot.truncation.totalBytes,
				maxLines: snapshot.truncation.maxLines,
				maxBytes: BACKGROUND_SNAPSHOT_BYTES,
			},
		};
	}

	/** A detach must check output written while in the foreground, preserving it. */
	checkLimit(): void {
		if (this.control.mode !== "background" || this.totalBytes <= this.maxBackgroundOutputBytes) return;
		if (this.limitAction === "truncate") {
			this.diskTruncated = true;
			this.log.stop();
		} else {
			this.fail(new Error(outputLimitError(this.maxBackgroundOutputBytes)));
		}
	}

	private appendChunk(chunk: Buffer): void {
		this.totalBytes += chunk.length;
		super.append(chunk);
		if (this.log.writeError !== undefined) this.fail(this.log.writeError);
	}

	private fail(error: unknown): void {
		if (this.error) return;
		this.error = error instanceof Error ? error : new Error(String(error));
		try {
			this.control.cancel();
		} catch {
			// Late data must not throw through a process observer.
		}
	}
}

interface ShellFailure {
	status: Extract<TaskTerminalStatus, "failed" | "cancelled" | "timeout">;
	error: string;
}

/** What the process itself reported, recorded before the native body formats it. */
interface ProcessOutcome {
	exitCode?: number | null;
	error?: unknown;
}

/** Interpret the documented BashOperations error markers and exit codes as the native body states them. */
function processFailure(outcome: ProcessOutcome): ShellFailure | undefined {
	const { error, exitCode } = outcome;
	if (error instanceof Error && error.message === "aborted") return { status: "cancelled", error: "Command aborted" };
	if (error instanceof Error && error.message.startsWith("timeout:"))
		return { status: "timeout", error: `Command timed out after ${error.message.split(":")[1]} seconds` };
	if (error !== undefined) return { status: "failed", error: errorMessage(error) };
	if (exitCode === null) return { status: "failed", error: "Command terminated without an exit code" };
	if (exitCode !== undefined && exitCode !== 0)
		return { status: "failed", error: `Command exited with code ${exitCode}` };
	return undefined;
}

function errorMessage(error: unknown): string {
	return boundText(error instanceof Error ? error.message : String(error), 4096);
}

/** The native body appends its failure status to the output; a task keeps them apart. */
function withoutStatus(text: string, status: string): string {
	if (text === status) return "";
	const suffix = `\n\n${status}`;
	return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function resultText(result: AgentToolResult<ShellDetails>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** The parts the native body runs with when it executes as a task. */
export interface ShellTaskParts {
	createOutput: () => OutputAccumulator;
	operations: BashOperations;
	onUpdate: (result: AgentToolResult<ShellDetails>) => void;
}

export interface ShellTaskOptions {
	control: ShellControl;
	operations: BashOperations;
	tempFilePrefix: string;
	timeout?: number;
	maxBackgroundOutputBytes?: number;
	backgroundOutputLimitAction?: TasksBackgroundOutputLimitAction;
	/** Runs the native tool body once with the task's parts. */
	execute: (parts: ShellTaskParts) => Promise<AgentToolResult<ShellDetails>>;
}

/**
 * One process and one output owner across foreground/background handoff. The task result holds
 * the command's output only; its failure is the completion's `error`.
 */
export async function runShellTask(options: ShellTaskOptions): Promise<TaskCompletion<ShellDetails>> {
	const { control } = options;
	if (control.signal.aborted) throw new Error("Command aborted");
	resolveTimeoutMs(options.timeout);
	const log = ManagedOutputFile.open(options.tempFilePrefix);
	const path = log.path;
	const cleanup = async () => {
		await log.close();
		await unlink(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	};
	const output = new TaskOutput(control, log, {
		tempFilePrefix: options.tempFilePrefix,
		maxBackgroundOutputBytes: options.maxBackgroundOutputBytes,
		backgroundOutputLimitAction: options.backgroundOutputLimitAction,
	});
	try {
		control.attachOutput(path, cleanup);
	} catch (error) {
		await cleanup();
		throw error;
	}
	const unsubscribe = control.onModeChange(() => output.checkLimit());
	const spawned: ProcessOutcome = {};
	const operations: BashOperations = {
		exec: (command, cwd, execOptions) => {
			let running: ReturnType<BashOperations["exec"]>;
			try {
				running = options.operations.exec(command, cwd, execOptions);
			} catch (error) {
				spawned.error = error;
				throw error;
			}
			// The process exists, so a handoff can no longer start it twice.
			control.accept();
			return running.then(
				(result) => {
					spawned.exitCode = result.exitCode;
					return result;
				},
				(error: unknown) => {
					spawned.error = error;
					throw error;
				},
			);
		},
	};
	let result: AgentToolResult<ShellDetails> | undefined;
	let thrown: unknown;
	try {
		try {
			result = await options.execute({
				createOutput: () => output,
				operations,
				onUpdate: (update) => control.publish({ result: update }),
			});
		} catch (error) {
			thrown = error;
		}
	} finally {
		unsubscribe();
		await output.closeTempFile();
	}
	return shellCompletion(output, path, spawned, result, thrown);
}

function shellCompletion(
	output: TaskOutput,
	path: string,
	spawned: ProcessOutcome,
	result: AgentToolResult<ShellDetails> | undefined,
	thrown: unknown,
): TaskCompletion<ShellDetails> {
	const started = "exitCode" in spawned || "error" in spawned;
	const failure =
		processFailure(spawned) ?? (thrown === undefined ? undefined : { status: "failed", error: errorMessage(thrown) });
	// The native result or error carries the formatted output; a raw operations error carries none.
	const formatted =
		result !== undefined
			? resultText(result)
			: thrown instanceof Error && thrown !== spawned.error && started
				? thrown.message
				: started
					? output.snapshot().content
					: "";
	const text = failure ? withoutStatus(formatted, failure.error) : formatted;
	const finalSnapshot = output.snapshot();
	const truncation = finalSnapshot.truncation;
	const outputFile = finalSnapshot.fullOutputFile;
	const details: BashToolDetails = {
		...(result?.details ?? (truncation.truncated ? { truncation } : {})),
		...(outputFile?.kind === "failed" ? { fullOutputError: outputFile.error } : { fullOutputPath: path }),
	};
	if (outputFile?.kind === "failed") delete details.fullOutputPath;
	// A cancellation the output policy caused is that policy's failure, not the process's abort.
	const policy = output.error ? { status: "failed" as const, error: errorMessage(output.error) } : undefined;
	const settled = policy ?? failure;
	const keepStructured = result?.structuredContent !== undefined && !policy;
	const facts: TaskFact[] = [];
	if (spawned.exitCode !== undefined)
		facts.push(["Exit", spawned.exitCode === null ? "signal" : String(spawned.exitCode)]);
	if (output.diskTruncated) {
		facts.push(["Log limit", `Disk log capped at ${formatSize(output.maxBackgroundOutputBytes)} (truncated)`]);
	}
	return {
		status: settled?.status,
		error: settled?.error,
		...(facts.length > 0 ? { facts } : {}),
		result: {
			...(keepStructured
				? { structuredContent: result!.structuredContent, ...(settled ? { isError: true } : {}) }
				: {}),
			content: [{ type: "text", text }],
			details,
		},
	};
}
