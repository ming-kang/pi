/**
 * Runs the native shell tool body (`bash.ts`) as one session task. The native body owns the
 * process, progress, output formatting and structured result; this adapter only supplies the
 * task's output log, its background limits and acceptance, and translates the native outcome
 * into a task completion.
 */
import { unlink } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { boundText } from "../tasks/output.ts";
import type { TaskCompletion, TaskControl, TaskTerminalStatus } from "../tasks/types.ts";
import { type BashOperations, resolveTimeoutMs } from "./bash.ts";
import { OutputAccumulator, type OutputAccumulatorOptions, type OutputSnapshot } from "./output-accumulator.ts";
import type { BashToolDetails } from "./shell-tool.ts";

export const MAX_BACKGROUND_OUTPUT_BYTES = 20 * 1024 * 1024;
/** Background snapshots stay within the task result budget, so the bounded result keeps the newest output. */
const BACKGROUND_SNAPSHOT_BYTES = 40 * 1024;
const OUTPUT_LIMIT_ERROR = "Background command exceeded the 20 MiB output limit";

type ShellDetails = BashToolDetails | undefined;
type ShellControl = TaskControl<ShellDetails>;

/**
 * A session task's output: persisted from the first byte to the log attached to the task, and
 * bounded once the task is background work. A write failure or the background cap cancels the
 * task instead of throwing through the process's data observer.
 */
class TaskOutput extends OutputAccumulator {
	error?: Error;
	private readonly control: ShellControl;

	constructor(control: ShellControl, options: OutputAccumulatorOptions) {
		super({ ...options, persistFromStart: true });
		this.control = control;
	}

	override append(data: Buffer): void {
		if (this.error) return;
		try {
			const room = MAX_BACKGROUND_OUTPUT_BYTES - this.getTotalBytes();
			if (this.control.mode === "background" && data.length > room) {
				super.append(data.subarray(0, Math.max(0, room)));
				this.fail(new Error(OUTPUT_LIMIT_ERROR));
			} else super.append(data);
		} catch (error) {
			this.fail(error);
		}
	}

	override snapshot(options: Parameters<OutputAccumulator["snapshot"]>[0] = {}): OutputSnapshot {
		return super.snapshot(
			this.control.mode === "background" ? { ...options, maxBytes: BACKGROUND_SNAPSHOT_BYTES } : options,
		);
	}

	/** A detach must check output written while in the foreground, preserving it. */
	checkLimit(): void {
		if (this.control.mode === "background" && this.getTotalBytes() > MAX_BACKGROUND_OUTPUT_BYTES)
			this.fail(new Error(OUTPUT_LIMIT_ERROR));
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
	const output = new TaskOutput(control, { tempFilePrefix: options.tempFilePrefix });
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
	const truncation = output.snapshot().truncation;
	const details: BashToolDetails = {
		...(result?.details ?? (truncation.truncated ? { truncation } : {})),
		fullOutputPath: path,
	};
	// A cancellation the output policy caused is that policy's failure, not the process's abort.
	const policy = output.error ? { status: "failed" as const, error: errorMessage(output.error) } : undefined;
	const settled = policy ?? failure;
	const keepStructured = result?.structuredContent !== undefined && !policy;
	return {
		status: settled?.status,
		error: settled?.error,
		...(spawned.exitCode !== undefined
			? { facts: [["Exit", spawned.exitCode === null ? "signal" : String(spawned.exitCode)]] }
			: {}),
		result: {
			...(keepStructured
				? { structuredContent: result!.structuredContent, ...(settled ? { isError: true } : {}) }
				: {}),
			content: [{ type: "text", text }],
			details,
		},
	};
}
