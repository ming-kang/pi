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
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations } from "../../core/tools/bash.ts";
import { formatSize } from "../../core/tools/truncate.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import { createOutputFileExclusively, type OutputSlice, readTail } from "./output-file.ts";
import { firstCommandLine } from "./text.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_RUNNING_TASKS = 8;
export const DEFAULT_NOTIFY_TAIL_BYTES = 4 * 1024;

const SHUTDOWN_GRACE_MS = 2_000;
const TASK_ID_ALLOCATION_ATTEMPTS = 100;

/** Stall watchdog defaults, matching Claude Code's CC-1175 tuning. */
export const STALL_POLL_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1_024;

/**
 * Last-line patterns that suggest a command is blocked waiting for keyboard
 * input. Used to gate the stall notification: a task that is merely slow
 * (git log -S, long silent builds) stays silent — only a tail that looks like
 * a prompt the model can act on triggers a notification.
 */
const STALL_PROMPT_PATTERNS: RegExp[] = [
	/\(y\/n\)/i, // (Y/n), (y/N)
	/\[y\/n\]/i, // [Y/n], [y/N]
	/\(yes\/no\)/i,
	/\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i, // directed questions
	/Press (any key|Enter)/i,
	/Continue\?/i,
	/Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
	const lastLine = tail.trimEnd().split("\n").pop() ?? "";
	return STALL_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

export type BgTaskStatus = "running" | "completed" | "failed" | "killed" | "timeout";

export interface BgTask {
	id: string;
	command: string;
	/** Optional model-provided label (e.g. "dev server") shown in /bg and notifications. */
	description?: string;
	cwd: string;
	status: BgTaskStatus;
	startedAt: number;
	endedAt?: number;
	/** True when the stall watchdog flagged this task as waiting for input. */
	stalled: boolean;
	/**
	 * Process exit code; null when reaped by a signal, undefined while running
	 * or when the run produced none (spawn failure, kill, timeout).
	 */
	exitCode: number | null | undefined;
	outputPath: string;
	/** Bytes accepted into the output file (excludes the overflow notice). */
	outputBytes: number;
	/** True when output hit the byte limit and the task was killed for it. */
	outputTruncated: boolean;
	error?: string;
	timeoutSeconds?: number;
	/** Delivery happened: a notification was sent, or a waiter returned this task inline. */
	notified: boolean;
}

/**
 * What a settled or stalled task hands to the extension for delivery.
 *
 * One shape with one discriminant, because both are delivered the same way and
 * carry the same payload; only the registry cares about the difference (a
 * completion participates in the delivery claim, a stall is informational and
 * bypasses it).
 */
export interface BgNotification {
	kind: "completion" | "stall";
	task: BgTask;
	/** Sanitized tail of the output file; absent when it could not be read. */
	tail: OutputSlice | undefined;
	/** Set when the output file could not be read; the notification still fires. */
	tailError?: string;
}

/** Outcome of a bounded wait: terminal delivery, or the wait window expiring. */
export type WaitOutcome = { outcome: "terminal"; task: BgTask } | { outcome: "timeout"; task: BgTask };

export interface BackgroundRegistryOptions {
	operations: BashOperations;
	/** Directory for task output files. Defaults to the system temp directory. */
	outputDir?: string;
	maxOutputBytes?: number;
	maxRunningTasks?: number;
	notifyTailBytes?: number;
	/** Called at most once per task per kind; synchronous throws do not prevent settlement. */
	onNotify: (notification: BgNotification) => void;
	/**
	 * Stall watchdog tuning; `false` disables the watchdog outright. Defaults
	 * follow Claude Code's CC-1175 (5s/45s/1KB).
	 */
	stall?: { pollIntervalMs?: number; thresholdMs?: number; tailBytes?: number } | false;
	/** Called whenever a task starts or reaches a terminal state. */
	onChange: () => void;
	now?: () => number;
	/** Test hook for deterministic collision coverage. */
	createTaskId?: () => string;
}

interface TaskRuntime {
	controller: AbortController;
	stream: WriteStream;
	killRequested: boolean;
	overflow: boolean;
	streamError?: string;
	finalized: boolean;
	/** Live waitForResult callers; the last one out sends the followUp if none delivered. */
	waiters: number;
	stallTimer: ReturnType<typeof setInterval> | undefined;
	stallLastSize: number;
	stallLastGrowthAt: number;
	/** One-shot latch: the stall notification fires at most once per task. */
	stallNotified: boolean;
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
	private readonly onNotify: (notification: BgNotification) => void;
	private readonly stallEnabled: boolean;
	private readonly stallPollIntervalMs: number;
	private readonly stallThresholdMs: number;
	private readonly stallTailBytes: number;
	private readonly onChange: () => void;
	private readonly now: () => number;
	private readonly createTaskId: () => string;

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
		const stall = options.stall === false ? undefined : options.stall;
		this.stallEnabled = options.stall !== false;
		this.stallPollIntervalMs = stall?.pollIntervalMs ?? STALL_POLL_INTERVAL_MS;
		this.stallThresholdMs = stall?.thresholdMs ?? STALL_THRESHOLD_MS;
		this.stallTailBytes = stall?.tailBytes ?? STALL_TAIL_BYTES;
		this.onChange = options.onChange;
		this.now = options.now ?? Date.now;
		this.createTaskId = options.createTaskId ?? (() => `bg-${randomBytes(3).toString("hex")}`);
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	startTask(input: {
		command: string;
		cwd: string;
		description?: string;
		timeoutSeconds?: number;
		env?: NodeJS.ProcessEnv;
	}): BgTask {
		if (this.shuttingDown) {
			throw new Error("Pi is shutting down; background task not started.");
		}
		const running = this.listTasks().filter((task) => task.status === "running");
		if (running.length >= this.maxRunningTasks) {
			const list = running.map((task) => `  ${task.id}  ${firstCommandLine(task.command)}`).join("\n");
			throw new Error(
				`Too many running background tasks (limit ${this.maxRunningTasks}). Kill one first (bg action kill):\n${list}`,
			);
		}

		const { id, outputPath } = this.allocateTaskOutput();
		const task: BgTask = {
			id,
			command: input.command,
			description: input.description,
			cwd: input.cwd,
			status: "running",
			startedAt: this.now(),
			exitCode: undefined,
			outputPath,
			outputBytes: 0,
			outputTruncated: false,
			timeoutSeconds: input.timeoutSeconds,
			notified: false,
			stalled: false,
		};

		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const runtime: TaskRuntime = {
			controller: new AbortController(),
			stream: createWriteStream(task.outputPath, { flags: "a" }),
			killRequested: false,
			overflow: false,
			finalized: false,
			waiters: 0,
			stallTimer: undefined,
			stallLastSize: 0,
			stallLastGrowthAt: this.now(),
			stallNotified: false,
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
		this.armStallWatchdog(task, runtime);
		void this.run(task, runtime, input.env);
		this.onChange();
		return task;
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

	/**
	 * Request a kill. Reports only whether one was issued: why it was not is
	 * already on the task (an unknown id cannot reach here through the tool,
	 * which resolves first, and a settled task carries its own status).
	 */
	killTask(id: string): { killed: boolean } {
		const task = this.tasks.get(id);
		const runtime = this.runtimes.get(id);
		if (!task || !runtime) return { killed: false };
		if (task.status !== "running" || runtime.finalized) return { killed: false };
		runtime.killRequested = true;
		runtime.controller.abort();
		return { killed: true };
	}

	counts(): Record<BgTaskStatus, number> & { total: number; stalled: number } {
		const counts = { running: 0, completed: 0, failed: 0, killed: 0, timeout: 0, total: 0, stalled: 0 };
		for (const task of this.tasks.values()) {
			counts[task.status]++;
			counts.total++;
			if (task.stalled) counts.stalled++;
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
	 * Bounded model-facing wait. Delivery is claimed by whoever actually
	 * delivers: a waiter that returns a terminal task marks it notified, so
	 * finalize's followUp is skipped and the completion is delivered exactly
	 * once, inline here.
	 *
	 * Nothing claims on behalf of anyone else, which is what makes an
	 * interrupted wait safe: an aborted waiter never marks the task notified,
	 * and the last waiter to leave without delivering sends the followUp itself.
	 * A waiter that arrives after the task already settled returns immediately
	 * without registering — the followUp may also arrive, an idempotent repeat
	 * rather than a lie.
	 */
	async waitForResult(id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown background task: ${id}`);
		const runtime = this.runtimes.get(id);
		if (!runtime) throw new Error(`Unknown background task: ${id}`);
		if (task.status !== "running") return { outcome: "terminal", task };

		runtime.waiters++;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Named so it can be removed: the signal outlives this wait, and one
		// orphaned listener per bg wait trips Node's max-listeners warning.
		let onAbort: (() => void) | undefined;
		try {
			const timedOut = await new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), timeoutMs);
				void runtime.done.then(() => resolve(false));
				onAbort = () => resolve(true);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			if (signal?.aborted) throw new Error("aborted");
			// done may resolve right after the timer fired (race window); a task
			// that reached a terminal state during the wait is delivered here.
			if (!timedOut || task.status !== "running") {
				task.notified = true;
				return { outcome: "terminal", task };
			}
			return { outcome: "timeout", task };
		} finally {
			runtime.waiters--;
			// Last one out and nobody delivered — the task settled while this wait
			// was in flight and the wait was then aborted, so send the followUp.
			// Gated on the terminal status, not runtime.finalized: finalize sets
			// that flag before the stream flush, while the task still reads as
			// running. A wait aborted inside that window is left to finalize, which
			// will see waiters === 0 by then.
			if (runtime.waiters === 0 && task.status !== "running" && !task.notified) {
				await this.notifyCompletion(task);
			}
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		}
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

	/**
	 * Stall watchdog (Claude Code CC-1175): poll the output file; when output
	 * stops growing past the threshold AND the tail looks like an interactive
	 * prompt, flag the task and fire a one-shot notification. Merely-slow tasks
	 * never match; recovery clears the flag (the notification never re-fires).
	 */
	private armStallWatchdog(task: BgTask, runtime: TaskRuntime): void {
		if (!this.stallEnabled) return;
		runtime.stallTimer = setInterval(() => this.checkStall(task, runtime), this.stallPollIntervalMs);
		runtime.stallTimer.unref?.();
	}

	private clearStallWatchdog(runtime: TaskRuntime): void {
		if (runtime.stallTimer !== undefined) {
			clearInterval(runtime.stallTimer);
			runtime.stallTimer = undefined;
		}
	}

	private checkStall(task: BgTask, runtime: TaskRuntime): void {
		if (runtime.finalized || this.shuttingDown) return;
		const size = task.outputBytes;
		if (size > runtime.stallLastSize) {
			runtime.stallLastSize = size;
			runtime.stallLastGrowthAt = this.now();
			if (task.stalled) {
				// Output resumed: reflect reality in listings, never re-notify.
				task.stalled = false;
				this.onChange();
			}
			return;
		}
		if (this.now() - runtime.stallLastGrowthAt < this.stallThresholdMs) return;
		void this.probeStallTail(task, runtime);
	}

	private async probeStallTail(task: BgTask, runtime: TaskRuntime): Promise<void> {
		// Re-check inside the async boundary: finalize may have raced the probe.
		if (runtime.finalized || this.shuttingDown) return;
		const { slice, error } = await readTail(task.outputPath, this.stallTailBytes);
		if (runtime.finalized || this.shuttingDown) return;
		// A read failure is not evidence of an interactive prompt. Retry after a
		// full threshold window without changing task state or notifying. Detection
		// uses raw text; sanitizing is only for delivery.
		if (error) {
			runtime.stallLastGrowthAt = this.now();
			return;
		}
		if (!slice || !looksLikePrompt(slice.text)) {
			runtime.stallLastGrowthAt = this.now();
			return;
		}
		if (!task.stalled) {
			task.stalled = true;
			this.onChange();
		}
		if (runtime.stallNotified) return;
		runtime.stallNotified = true;
		this.emit("stall", task, slice, error);
	}

	/** The one place a notification payload is shaped, for either kind. */
	private emit(kind: BgNotification["kind"], task: BgTask, slice: OutputSlice | undefined, tailError?: string): void {
		try {
			this.onNotify({
				kind,
				task,
				tail: slice && { ...slice, text: sanitizeBinaryOutput(slice.text) },
				tailError,
			});
		} catch {
			// Notification failures must not undo task completion or prevent settlement;
			// there is no retry path, so the delivery record stands.
		}
	}

	private allocateTaskOutput(): { id: string; outputPath: string } {
		for (let attempt = 0; attempt < TASK_ID_ALLOCATION_ATTEMPTS; attempt++) {
			const id = this.createTaskId();
			if (this.tasks.has(id)) continue;
			const outputPath = join(this.outputDir, `pi-${id}.log`);
			try {
				// Create synchronously before returning the task so read/wait and /bg
				// never see ENOENT. `wx` also protects stale logs and symlinks.
				createOutputFileExclusively(outputPath);
				return { id, outputPath };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw error;
			}
		}
		throw new Error(`Could not allocate a unique background task id after ${TASK_ID_ALLOCATION_ATTEMPTS} attempts.`);
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
		this.clearStallWatchdog(runtime);
		task.stalled = false;

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
		// Nothing is claimed on anyone's behalf: if a waiter is registered it gets
		// first refusal, and whichever of them leaves last without having
		// delivered sends the followUp from waitForResult's finally.
		if (runtime.waiters === 0) await this.notifyCompletion(task);
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
		const { slice, error } = await readTail(task.outputPath, this.notifyTailBytes);
		this.emit("completion", task, slice, error);
	}
}
