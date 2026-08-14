/**
 * Background task registry: process lifecycle, output capture, completion
 * notification. Pure logic — no UI imports, dependencies injected for tests.
 *
 * Discipline (mirrors the reference implementation this extension distills):
 * - Output streams straight to a file; memory holds only a byte counter.
 * - Finalization is idempotent and strictly ordered: flush stream, set
 *   terminal state, then notify. A notification is only sent once the output
 *   file holds the complete truth.
 * - Kill goes through AbortController; the shared bash operations kill the
 *   whole process tree cross-platform.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "../../core/tools/bash.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_RUNNING_TASKS = 8;
export const DEFAULT_NOTIFY_TAIL_BYTES = 4 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;

export type BgTaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export interface BgTask {
	id: string;
	command: string;
	cwd: string;
	status: BgTaskStatus;
	startedAt: number;
	endedAt?: number;
	/** Process exit code; null when reaped by a signal, undefined while running or when spawn failed. */
	exitCode: number | null | undefined;
	outputPath: string;
	/** Bytes accepted into the output file (excludes the overflow notice). */
	outputBytes: number;
	/** True when output hit the byte limit and the task was killed for it. */
	outputTruncated: boolean;
	error?: string;
	timeoutSeconds?: number;
	notified: boolean;
}

export interface BgTaskNotification {
	task: BgTask;
	/** Sanitized tail of the output file; empty when unavailable. */
	tailText: string;
	tailBytes: number;
	totalBytes: number;
	tailTruncated: boolean;
	tailStartsMidLine: boolean;
	/** Set when the output file could not be read; the notification still fires. */
	tailError?: string;
}

export interface OutputSlice {
	text: string;
	sliceBytes: number;
	totalBytes: number;
	/** True when the file holds more bytes than the slice. */
	truncated: boolean;
	/** True in tail mode when the slice starts mid-line. */
	startsMidLine: boolean;
}

/**
 * Read a bounded slice from the head or tail of a file via positioned reads —
 * never the whole file. Tail reads skip UTF-8 continuation bytes so the text
 * starts on a codepoint boundary.
 */
export async function readOutputSlice(
	filePath: string,
	options: { mode: "head" | "tail"; maxBytes: number },
): Promise<OutputSlice> {
	const file = await open(filePath, "r");
	try {
		const { size } = await file.stat();
		let length = Math.min(size, Math.max(0, Math.floor(options.maxBytes)));
		let position = options.mode === "tail" ? size - length : 0;
		let startsMidLine = false;

		if (options.mode === "tail" && position > 0 && length > 0) {
			// Probe from one byte before the slice: probe[0] tells whether the
			// slice starts at a line boundary, the rest lets us skip UTF-8
			// continuation bytes (0b10xxxxxx) so we never split a codepoint.
			const probeStart = position - 1;
			const probe = Buffer.alloc(Math.min(5, size - probeStart));
			await file.read(probe, 0, probe.length, probeStart);
			let skip = 0;
			while (1 + skip < probe.length && ((probe[1 + skip] ?? 0) & 0b1100_0000) === 0b1000_0000) {
				skip++;
			}
			position += skip;
			length -= skip;
			startsMidLine = probe[skip] !== 0x0a;
		}

		const buffer = Buffer.alloc(Math.max(0, length));
		const bytesRead = buffer.length > 0 ? (await file.read(buffer, 0, buffer.length, position)).bytesRead : 0;
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			sliceBytes: bytesRead,
			totalBytes: size,
			truncated: size > bytesRead,
			startsMidLine,
		};
	} finally {
		await file.close();
	}
}

export interface BackgroundRegistryOptions {
	operations: BashOperations;
	/** Directory for task output files. Defaults to the system temp directory. */
	outputDir?: string;
	maxOutputBytes?: number;
	maxRunningTasks?: number;
	notifyTailBytes?: number;
	/** Called once per finished task; a synchronous throw rolls back `notified`. */
	onNotify: (notification: BgTaskNotification) => void;
	/** Called whenever a task starts or reaches a terminal state. */
	onChange: () => void;
	now?: () => number;
}

interface TaskRuntime {
	controller: AbortController;
	stream: WriteStream;
	killRequested: boolean;
	overflow: boolean;
	streamError?: string;
	finalized: boolean;
	done: Promise<void>;
	resolveDone: () => void;
}

export type ResolveTaskResult =
	| { ok: true; task: BgTask }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates: BgTask[] };

export class BackgroundTaskRegistry {
	private readonly operations: BashOperations;
	private readonly outputDir: string;
	private readonly maxOutputBytes: number;
	private readonly maxRunningTasks: number;
	private readonly notifyTailBytes: number;
	private readonly onNotify: (notification: BgTaskNotification) => void;
	private readonly onChange: () => void;
	private readonly now: () => number;

	private readonly tasks = new Map<string, BgTask>();
	private readonly runtimes = new Map<string, TaskRuntime>();
	private shuttingDown = false;

	constructor(options: BackgroundRegistryOptions) {
		this.operations = options.operations;
		this.outputDir = options.outputDir ?? tmpdir();
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		this.maxRunningTasks = options.maxRunningTasks ?? DEFAULT_MAX_RUNNING_TASKS;
		this.notifyTailBytes = options.notifyTailBytes ?? DEFAULT_NOTIFY_TAIL_BYTES;
		this.onNotify = options.onNotify;
		this.onChange = options.onChange;
		this.now = options.now ?? Date.now;
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	startTask(input: { command: string; cwd: string; timeoutSeconds?: number; env?: NodeJS.ProcessEnv }): BgTask {
		if (this.shuttingDown) {
			throw new Error("Pi is shutting down; background task not started.");
		}
		const running = this.listTasks().filter((task) => task.status === "running");
		if (running.length >= this.maxRunningTasks) {
			const list = running.map((task) => `  ${task.id}  ${firstCommandLine(task.command)}`).join("\n");
			throw new Error(
				`Too many running background tasks (limit ${this.maxRunningTasks}). Kill one with bg_kill first:\n${list}`,
			);
		}

		const id = this.newTaskId();
		const task: BgTask = {
			id,
			command: input.command,
			cwd: input.cwd,
			status: "running",
			startedAt: this.now(),
			exitCode: undefined,
			outputPath: join(this.outputDir, `pi-${id}.log`),
			outputBytes: 0,
			outputTruncated: false,
			timeoutSeconds: input.timeoutSeconds,
			notified: false,
		};

		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		// Create the file synchronously so bg_logs and the /bg viewer never see
		// ENOENT between task start and the stream's async open.
		writeFileSync(task.outputPath, "");
		const runtime: TaskRuntime = {
			controller: new AbortController(),
			stream: createWriteStream(task.outputPath, { flags: "a" }),
			killRequested: false,
			overflow: false,
			finalized: false,
			done,
			resolveDone,
		};
		runtime.stream.on("error", (error) => {
			if (runtime.finalized) return;
			runtime.streamError = error.message;
			runtime.controller.abort();
		});

		this.tasks.set(id, task);
		this.runtimes.set(id, runtime);
		void this.run(task, runtime, input.env);
		this.onChange();
		return task;
	}

	getTask(id: string): BgTask | undefined {
		return this.tasks.get(id);
	}

	/** Running tasks first (oldest first), then finished tasks (newest first). */
	listTasks(): BgTask[] {
		const all = [...this.tasks.values()];
		const running = all.filter((task) => task.status === "running");
		running.sort((a, b) => a.startedAt - b.startedAt);
		const ended = all.filter((task) => task.status !== "running");
		ended.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		return [...running, ...ended];
	}

	/** Resolve a task by id or unique id prefix; the "bg-" prefix may be omitted. */
	resolveTask(idPrefix: string): ResolveTaskResult {
		const needle = idPrefix.trim();
		if (!needle) return { ok: false, reason: "not-found", candidates: [] };
		const exact = this.tasks.get(needle) ?? this.tasks.get(`bg-${needle}`);
		if (exact) return { ok: true, task: exact };
		const candidates = [...this.tasks.values()].filter(
			(task) => task.id.startsWith(needle) || task.id.startsWith(`bg-${needle}`),
		);
		const first = candidates[0];
		if (candidates.length === 1 && first) return { ok: true, task: first };
		if (candidates.length === 0) return { ok: false, reason: "not-found", candidates: [] };
		return { ok: false, reason: "ambiguous", candidates };
	}

	killTask(id: string): { killed: true } | { killed: false; reason: "not-found" | "not-running" } {
		const task = this.tasks.get(id);
		const runtime = this.runtimes.get(id);
		if (!task || !runtime) return { killed: false, reason: "not-found" };
		if (task.status !== "running" || runtime.finalized) return { killed: false, reason: "not-running" };
		runtime.killRequested = true;
		runtime.controller.abort();
		return { killed: true };
	}

	counts(): Record<BgTaskStatus, number> & { total: number } {
		const counts = { running: 0, completed: 0, failed: 0, killed: 0, timeout: 0, total: 0 };
		for (const task of this.tasks.values()) {
			counts[task.status]++;
			counts.total++;
		}
		return counts;
	}

	/** Resolves once the task has finalized, including its notification attempt. */
	async waitForTask(id: string): Promise<BgTask> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown background task: ${id}`);
		await this.runtimes.get(id)?.done;
		return task;
	}

	/**
	 * Mute notifications, refuse new tasks, abort every running task, and wait
	 * (bounded) for their finalization.
	 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const pending: Promise<void>[] = [];
		for (const [id, runtime] of this.runtimes) {
			const task = this.tasks.get(id);
			if (task?.status === "running" && !runtime.finalized) {
				runtime.killRequested = true;
				runtime.controller.abort();
			}
			pending.push(runtime.done);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
		});
		try {
			await Promise.race([Promise.allSettled(pending).then(() => undefined), grace]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private newTaskId(): string {
		while (true) {
			const id = `bg-${randomBytes(3).toString("hex")}`;
			if (!this.tasks.has(id)) return id;
		}
	}

	private async run(task: BgTask, runtime: TaskRuntime, env?: NodeJS.ProcessEnv): Promise<void> {
		let outcome: { exitCode?: number | null; error?: unknown };
		try {
			const result = await this.operations.exec(task.command, task.cwd, {
				onData: (data) => this.handleData(task, runtime, data),
				signal: runtime.controller.signal,
				timeout: task.timeoutSeconds,
				env,
			});
			outcome = { exitCode: result.exitCode };
		} catch (error) {
			outcome = { error };
		}
		await this.finalize(task, runtime, outcome);
	}

	private handleData(task: BgTask, runtime: TaskRuntime, data: Buffer): void {
		if (runtime.finalized || runtime.overflow || runtime.streamError !== undefined) return;
		const next = task.outputBytes + data.length;
		if (next <= this.maxOutputBytes) {
			runtime.stream.write(data);
			task.outputBytes = next;
			return;
		}
		const budget = this.maxOutputBytes - task.outputBytes;
		if (budget > 0) {
			runtime.stream.write(data.subarray(0, budget));
			task.outputBytes = this.maxOutputBytes;
		}
		runtime.stream.write(`\n[output limit ${formatSize(this.maxOutputBytes)} exceeded; task killed]\n`);
		task.outputTruncated = true;
		runtime.overflow = true;
		runtime.controller.abort();
	}

	private async finalize(
		task: BgTask,
		runtime: TaskRuntime,
		outcome: { exitCode?: number | null; error?: unknown },
	): Promise<void> {
		if (runtime.finalized) return;
		runtime.finalized = true;

		// Flush before setting terminal state: the output file must hold the
		// complete truth by the time anyone is told the task ended.
		await new Promise<void>((resolve) => {
			const stream = runtime.stream;
			if (stream.destroyed) {
				resolve();
				return;
			}
			stream.on("close", resolve);
			stream.end(() => resolve());
		});

		const verdict = this.classifyOutcome(runtime, outcome);
		task.status = verdict.status;
		if (verdict.error !== undefined) task.error = verdict.error;
		task.exitCode = outcome.exitCode;
		task.endedAt = this.now();
		this.onChange();
		await this.notifyCompletion(task);
		runtime.resolveDone();
	}

	private classifyOutcome(
		runtime: TaskRuntime,
		outcome: { exitCode?: number | null; error?: unknown },
	): { status: BgTaskStatus; error?: string } {
		if (runtime.overflow) {
			return {
				status: "failed",
				error: `Output exceeded the ${formatSize(this.maxOutputBytes)} limit; the task was killed.`,
			};
		}
		if (runtime.streamError !== undefined) {
			return { status: "failed", error: `Output file error: ${runtime.streamError}` };
		}
		if (runtime.killRequested) return { status: "killed" };
		const error = outcome.error;
		if (error instanceof Error) {
			if (error.message === "aborted") return { status: "killed" };
			if (error.message.startsWith("timeout:")) {
				return { status: "timeout", error: `Timed out after ${error.message.slice("timeout:".length)}s.` };
			}
			return { status: "failed", error: error.message };
		}
		if (error !== undefined) return { status: "failed", error: String(error) };
		if (outcome.exitCode === 0) return { status: "completed" };
		if (outcome.exitCode === null) return { status: "failed", error: "Command was terminated by a signal." };
		return { status: "failed", error: `Command exited with code ${outcome.exitCode}` };
	}

	private async notifyCompletion(task: BgTask): Promise<void> {
		if (this.shuttingDown || task.notified) return;
		task.notified = true;

		let tailText = "";
		let tailBytes = 0;
		let totalBytes = task.outputBytes;
		let tailTruncated = false;
		let tailStartsMidLine = false;
		let tailError: string | undefined;
		try {
			const slice = await readOutputSlice(task.outputPath, { mode: "tail", maxBytes: this.notifyTailBytes });
			tailText = sanitizeBinaryOutput(slice.text);
			tailBytes = slice.sliceBytes;
			totalBytes = slice.totalBytes;
			tailTruncated = slice.truncated;
			tailStartsMidLine = slice.startsMidLine;
		} catch (error) {
			tailError = error instanceof Error ? error.message : String(error);
		}

		try {
			this.onNotify({ task, tailText, tailBytes, totalBytes, tailTruncated, tailStartsMidLine, tailError });
		} catch {
			// The send failed synchronously (e.g. stale extension runtime after a
			// session replacement); do not pretend the notification was delivered.
			task.notified = false;
		}
	}
}

/** First non-empty line of a command, trimmed — for one-line task labels. */
export function firstCommandLine(command: string): string {
	const line = command.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? command;
	return line.trim();
}

/** Compact duration like Pi's own timers: 12s, 3m05s, 1h02m. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
