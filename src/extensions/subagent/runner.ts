import { relative } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { sleep } from "../../utils/sleep.ts";
import { boundText, emptyUsage, mergeUsage, toNestedUsage } from "./activity.ts";
import {
	DETAILS_ACTIVITY_LIMIT,
	DETAILS_OUTPUT_LIMIT,
	ERROR_TEXT_LIMIT,
	MAX_CONCURRENCY,
	MAX_TASKS,
	RETRY_ERROR_TEXT_LIMIT,
	TASK_OUTPUT_LIMIT,
	TASK_RETRY_BASE_DELAY_MS,
	TASK_RETRY_LIMIT,
	TOTAL_OUTPUT_LIMIT,
} from "./constants.ts";
import { type ParentModelContext, resolveSubagentTask } from "./resolve.ts";
import { beginSubagentRetry, clearSubagentRetry } from "./retry.ts";
import type { SubagentParams, SubagentTask } from "./schema.ts";
import { runSdkTask } from "./sdk-runner.ts";
import { loadSubagentConfig } from "./settings.ts";
import type {
	ResolvedSubagentTask,
	SubagentDetails,
	SubagentExecutionResult,
	SubagentRunDetails,
	SubagentUsage,
} from "./types.ts";

const EMPTY_OUTPUT = "(Subagent completed but returned no output.)";

interface Waiter {
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abortListener?: () => void;
}

export class ConcurrencyGate {
	private active = 0;
	private readonly waiters: Waiter[] = [];
	private readonly limit: number;

	constructor(limit = MAX_CONCURRENCY) {
		this.limit = limit;
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted while queued."));
		if (this.active < this.limit) {
			this.active++;
			return Promise.resolve(() => this.release());
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal };
			if (signal) {
				waiter.abortListener = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(new Error("Subagent was aborted while queued."));
				};
				signal.addEventListener("abort", waiter.abortListener, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift()!;
			if (waiter.signal?.aborted) {
				waiter.abortListener?.();
				continue;
			}
			waiter.signal?.removeEventListener("abort", waiter.abortListener!);
			this.active++;
			waiter.resolve(() => this.release());
			return;
		}
	}
}

export interface SubagentInvocationOptions {
	params: SubagentParams;
	parentCwd: string;
	parent: ParentModelContext;
	modelRuntime: ModelRuntime;
	agentDir: string;
	projectTrusted: boolean;
	signal?: AbortSignal;
	gate: ConcurrencyGate;
	onUpdate?: (details: SubagentDetails) => void;
	registerAbort?: (abort: () => Promise<void>) => () => void;
	/** Test hook: overrides the task-retry backoff base delay. */
	taskRetryBaseDelayMs?: number;
}

function runId(index: number): string {
	return `subagent-${index + 1}`;
}

function createRun(task: ResolvedSubagentTask, index: number, parentCwd: string): SubagentRunDetails {
	return {
		id: runId(index),
		agent: task.agent.name,
		description: task.description,
		// Display-only relative path; the worker session itself uses the
		// resolved absolute task.cwd. Empty means "same as the parent".
		cwd: relative(parentCwd, task.cwd),
		model: `${task.model.provider}/${task.model.id}`,
		thinking: task.thinking,
		status: "queued",
		activities: [],
		report: "",
		usage: emptyUsage(),
	};
}

function aggregateUsage(runs: readonly SubagentRunDetails[]): SubagentUsage {
	const usage = emptyUsage();
	for (const run of runs) mergeUsage(usage, run.usage);
	return usage;
}

interface TextField {
	get: () => string;
	set: (value: string) => void;
}

function detailsSize(details: SubagentDetails): number {
	return Buffer.byteLength(JSON.stringify(details), "utf8");
}

export function boundSubagentDetails(details: SubagentDetails): SubagentDetails {
	const perRunBudget = Math.max(
		1_024,
		Math.floor((DETAILS_OUTPUT_LIMIT - 8 * 1024) / Math.max(1, details.runs.length)),
	);
	const reportLimit = Math.min(TASK_OUTPUT_LIMIT, Math.max(1_024, perRunBudget - 7 * 1024));
	const bounded: SubagentDetails = {
		...details,
		runs: details.runs.map((run) => ({
			...run,
			cwd: boundText(run.cwd, 1_024),
			currentActivity: run.currentActivity ? boundText(run.currentActivity, 512) : undefined,
			retry: run.retry ? { ...run.retry, error: boundText(run.retry.error, RETRY_ERROR_TEXT_LIMIT) } : undefined,
			activities: run.activities.slice(-DETAILS_ACTIVITY_LIMIT).map((activity) => ({
				...activity,
				summary: boundText(activity.summary, 256),
				resultSummary: activity.resultSummary ? boundText(activity.resultSummary, 256) : undefined,
			})),
			report: boundText(run.report, reportLimit),
			error: run.error ? boundText(run.error, 1_024) : undefined,
		})),
	};
	const fields: TextField[] = [];
	for (const run of bounded.runs) {
		fields.push(
			{
				get: () => run.cwd,
				set: (value) => {
					run.cwd = value;
				},
			},
			{
				get: () => run.currentActivity ?? "",
				set: (value) => {
					run.currentActivity = value || undefined;
				},
			},
			{
				get: () => run.report,
				set: (value) => {
					run.report = value;
				},
			},
			{
				get: () => run.error ?? "",
				set: (value) => {
					run.error = value || undefined;
				},
			},
		);
		for (const activity of run.activities) {
			fields.push(
				{
					get: () => activity.summary,
					set: (value) => {
						activity.summary = value;
					},
				},
				{
					get: () => activity.resultSummary ?? "",
					set: (value) => {
						activity.resultSummary = value || undefined;
					},
				},
			);
		}
	}
	while (detailsSize(bounded) > DETAILS_OUTPUT_LIMIT) {
		const largest = fields
			.map((field) => ({ field, size: Buffer.byteLength(field.get(), "utf8") }))
			.sort((left, right) => right.size - left.size)[0];
		if (!largest || largest.size === 0) break;
		const overflow = detailsSize(bounded) - DETAILS_OUTPUT_LIMIT;
		largest.field.set(boundText(largest.field.get(), Math.max(0, largest.size - overflow)));
	}
	return bounded;
}

function statusOf(runs: readonly SubagentRunDetails[]): SubagentDetails["status"] {
	// Active beats terminal: any queued or running run keeps the batch
	// "running" regardless of what the others have settled to.
	if (runs.some((run) => run.status === "queued" || run.status === "running")) return "running";
	if (runs.length === 0) return "running";
	if (runs.every((run) => run.status === "completed")) return "completed";
	if (runs.some((run) => run.status === "completed")) return "partial";
	if (runs.every((run) => run.status === "aborted")) return "aborted";
	return "failed";
}

function statusText(details: SubagentDetails): string {
	if (details.runs.length === 0) return "Initializing…";
	const running = details.runs.filter((run) => run.status === "running").length;
	const queued = details.runs.filter((run) => run.status === "queued").length;
	const completed = details.runs.filter((run) => run.status === "completed").length;
	const failed = details.runs.filter((run) => run.status === "failed").length;
	const aborted = details.runs.filter((run) => run.status === "aborted").length;
	const parts = [`${completed}/${details.runs.length} complete`];
	if (running) parts.push(`${running} running`);
	if (queued) parts.push(`${queued} queued`);
	if (failed) parts.push(`${failed} failed`);
	if (aborted) parts.push(`${aborted} aborted`);
	return parts.join(" · ");
}

function emitDetails(
	runs: SubagentRunDetails[],
	startedAt: number,
	onUpdate: ((details: SubagentDetails) => void) | undefined,
): SubagentDetails {
	const details: SubagentDetails = {
		status: statusOf(runs),
		runs: [...runs],
		startedAt,
		usage: aggregateUsage(runs),
	};
	onUpdate?.(boundSubagentDetails(details));
	return details;
}

function validateTaskCount(tasks: readonly SubagentTask[]): void {
	if (tasks.length === 0) throw new Error("Subagent task list must not be empty.");
	if (tasks.length > MAX_TASKS) throw new Error(`Subagent task list is limited to ${MAX_TASKS} tasks.`);
}

async function resolveTasks(
	tasks: readonly SubagentTask[],
	options: SubagentInvocationOptions,
): Promise<ResolvedSubagentTask[]> {
	validateTaskCount(tasks);
	// One config load and one resolution pass for the whole batch: every
	// task/profile/cwd/model is settled before any run is created or any
	// worker starts, so a failing task cannot strand half-initialized runs.
	const config = await loadSubagentConfig(options.agentDir);
	return Promise.all(
		tasks.map((task, index) =>
			resolveSubagentTask(task, options.parentCwd, options.parent, options.agentDir, config).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Subagent task tasks[${index}] failed to resolve: ${message}`);
			}),
		),
	);
}

// Reuses pi-ai's provider-error classification by wrapping the stored error
// text in the assistant-message shape it inspects.
function isRetryableRunError(error: string | undefined): boolean {
	if (!error) return false;
	const probe = { role: "assistant", content: [], stopReason: "error", errorMessage: error };
	return isRetryableAssistantError(probe as unknown as Parameters<typeof isRetryableAssistantError>[0]);
}

// Session-level auto-retry already covers errors that happen inside the agent
// loop; this catches the paths that bypass it (preflight throws such as auth
// checks). Only a run that produced nothing is retried, so partial work is
// never discarded.
function shouldRetryTask(run: SubagentRunDetails): boolean {
	return (
		run.status === "failed" && run.usage.turns === 0 && run.usage.toolUses === 0 && isRetryableRunError(run.error)
	);
}

function resetRunForRetry(run: SubagentRunDetails, attempt: number, maxAttempts: number, delayMs: number): void {
	const error = run.error ?? "Subagent failed before retry.";
	run.status = "queued";
	run.error = undefined;
	run.startedAt = undefined;
	run.endedAt = undefined;
	run.report = "";
	run.activities.length = 0;
	run.usage = emptyUsage();
	beginSubagentRetry(run, { attempt, maxAttempts, delayMs, error });
}

async function waitForTaskRetry(
	delayMs: number,
	options: Pick<SubagentInvocationOptions, "signal" | "registerAbort">,
): Promise<void> {
	const controller = new AbortController();
	const abort = async (): Promise<void> => controller.abort();
	const unregisterAbort = options.registerAbort?.(abort);
	const abortListener = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	else options.signal?.addEventListener("abort", abortListener, { once: true });
	try {
		await sleep(delayMs, controller.signal);
	} finally {
		options.signal?.removeEventListener("abort", abortListener);
		unregisterAbort?.();
	}
}

// The gate slot is held only while a worker session actually runs. Backoff
// waits outside the slot (release, sleep, reacquire) so a retrying task
// cannot starve queued tasks, and aborting during the wait settles the run
// without occupying the gate.
async function runWithGate(
	task: ResolvedSubagentTask,
	run: SubagentRunDetails,
	options: SubagentInvocationOptions,
	onProgress: () => void,
): Promise<SubagentRunDetails> {
	onProgress();
	const baseDelayMs = options.taskRetryBaseDelayMs ?? TASK_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; ; attempt++) {
		clearSubagentRetry(run);
		let release: (() => void) | undefined;
		let delayMs = 0;
		try {
			release = await options.gate.acquire(options.signal);
			if (options.signal?.aborted) {
				run.status = "aborted";
				run.error = "Subagent was aborted while queued.";
				run.endedAt = Date.now();
				return run;
			}
			const result = await runSdkTask({
				task,
				run,
				modelRuntime: options.modelRuntime,
				agentDir: options.agentDir,
				projectTrusted: options.projectTrusted,
				signal: options.signal,
				onProgress,
				registerAbort: options.registerAbort,
			});
			if (attempt >= TASK_RETRY_LIMIT || options.signal?.aborted || !shouldRetryTask(result)) return result;
			delayMs = baseDelayMs * 2 ** attempt;
			resetRunForRetry(run, attempt + 1, TASK_RETRY_LIMIT, delayMs);
			onProgress();
		} catch (error) {
			clearSubagentRetry(run);
			run.status = options.signal?.aborted ? "aborted" : "failed";
			run.error = boundText(error instanceof Error ? error.message : String(error), ERROR_TEXT_LIMIT);
			run.endedAt = Date.now();
			onProgress();
			return run;
		} finally {
			release?.();
		}
		try {
			await waitForTaskRetry(delayMs, options);
		} catch {
			clearSubagentRetry(run);
			run.status = "aborted";
			run.error = "Subagent was aborted while waiting to retry.";
			run.endedAt = Date.now();
			onProgress();
			return run;
		}
	}
}

// Fair per-task report budget: the total cap is split evenly after reserving
// room for the numbered section headings and separators, capped per task.
function perTaskReportBudget(taskCount: number): number {
	const headingReserve = Math.min(256 * taskCount, Math.floor(TOTAL_OUTPUT_LIMIT / 4));
	const fairShare = Math.floor((TOTAL_OUTPUT_LIMIT - headingReserve) / Math.max(1, taskCount));
	return Math.min(TASK_OUTPUT_LIMIT, Math.max(2_048, fairShare));
}

function reportSectionTitle(run: SubagentRunDetails, index: number): string {
	return `### ${index + 1}. ${run.description} (${run.agent}) — ${run.status}`;
}

function reportSectionBody(run: SubagentRunDetails): string {
	if (run.status === "completed") return run.report || EMPTY_OUTPUT;
	if (run.status === "failed" || run.status === "aborted") {
		const verdict = run.status === "aborted" ? "Subagent aborted" : "Subagent failed";
		const cause = run.error ? `: ${run.error}` : ".";
		const partial = run.report ? `\n\nPartial report:\n${run.report}` : "";
		return `${verdict}${cause}${partial}`;
	}
	if (run.status === "queued") return "Task was queued and never started.";
	return "Task was still running when the batch settled.";
}

// Always ordered numbered sections, even for a single task, so the parent
// can reference results by number. Total cap with a fair per-task budget;
// empty, failed, aborted, and partial reports are labeled explicitly.
function resultContent(details: SubagentDetails): string {
	const perTaskBudget = perTaskReportBudget(details.runs.length);
	const sections = details.runs.map((run, index) => {
		return `${reportSectionTitle(run, index)}\n\n${boundText(reportSectionBody(run), perTaskBudget)}`;
	});
	return boundText(sections.join("\n\n---\n\n"), TOTAL_OUTPUT_LIMIT);
}

// Cheap change detector: consecutive events that alter nothing user-visible
// skip the bounded-details serialization in emitDetails entirely. Every
// activity contributes its status, not just the last one: agent-core can end
// parallel tool executions out of order, and a mid-list row settling then
// would otherwise slip past the detector.
export function progressKey(runs: readonly SubagentRunDetails[]): string {
	return runs
		.map((run) => {
			return [
				run.status,
				run.currentActivity ?? "",
				run.activities.length,
				run.activities.map((activity) => `${activity.status}:${activity.resultSummary ?? ""}`).join(","),
				run.retry?.attempt ?? "",
				run.retry?.maxAttempts ?? "",
				run.retry?.deadline ?? "",
				run.retry?.error ?? "",
				run.report.length,
				run.usage.turns,
				run.usage.toolUses,
				run.usage.totalTokens,
				run.error ?? "",
			].join("|");
		})
		.join("~");
}

export function isSubagentError(details: Pick<SubagentDetails, "status" | "runs">): boolean {
	if (details.status !== "failed" && details.status !== "aborted") return false;
	// A batch with any successful run is a partial result, not an error:
	// per-run status is already reported in the content sections.
	return !details.runs.some((run) => run.status === "completed");
}

export async function runSubagentInvocation(options: SubagentInvocationOptions): Promise<SubagentExecutionResult> {
	// Defensive count check: the schema already enforces 1..MAX_TASKS, but
	// strict providers can bypass minItems, so validate before any work.
	const tasks = options.params.tasks ?? [];
	const resolved = await resolveTasks(tasks, options);
	const runs = resolved.map((task, index) => createRun(task, index, options.parentCwd));
	const startedAt = Date.now();
	let latestDetails = emitDetails(runs, startedAt, options.onUpdate);
	let lastProgressKey = progressKey(runs);
	const progress = () => {
		const key = progressKey(runs);
		if (key === lastProgressKey) return;
		lastProgressKey = key;
		latestDetails = emitDetails(runs, startedAt, options.onUpdate);
	};

	// Every task runs concurrently through the shared gate; Promise.all keeps
	// result order identical to input order. There is no single-task branch:
	// one task is just a batch of one.
	await Promise.all(resolved.map((task, index) => runWithGate(task, runs[index]!, options, progress)));
	latestDetails = emitDetails(runs, startedAt, undefined);
	latestDetails.endedAt = Date.now();
	// Error classification lives in the tool_result handler (index.ts), the
	// only channel that reaches the session transcript and export.
	return {
		content: resultContent(latestDetails),
		details: boundSubagentDetails(latestDetails),
		usage: toNestedUsage(latestDetails.usage),
	};
}

export function statusSummary(details: SubagentDetails): string {
	return statusText(details);
}
