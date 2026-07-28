import { relative } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { sleep } from "../../utils/sleep.ts";
import { boundText, emptyUsage, mergeUsage, tailText, toNestedUsage } from "./activity.ts";
import {
	DETAILS_ACTIVITY_LIMIT,
	DETAILS_OUTPUT_LIMIT,
	ERROR_TEXT_LIMIT,
	MAX_CONCURRENCY,
	MAX_TASKS,
	PARALLEL_OUTPUT_LIMIT,
	PARALLEL_TASK_OUTPUT_LIMIT,
	RETRY_ERROR_TEXT_LIMIT,
	SINGLE_OUTPUT_LIMIT,
	TASK_RETRY_BASE_DELAY_MS,
	TASK_RETRY_LIMIT,
} from "./constants.ts";
import { type ParentModelContext, resolveSubagentTask } from "./resolve.ts";
import { beginSubagentRetry, clearSubagentRetry } from "./retry.ts";
import type { SubagentParams, SubagentTask } from "./schema.ts";
import { runSdkTask } from "./sdk-runner.ts";
import { loadSubagentConfig } from "./settings.ts";
import type {
	AgentDefinition,
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
			const waiter = this.waiters.shift();
			if (!waiter) return;
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
	agents: readonly AgentDefinition[];
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
		agentSource: task.agent.source,
		description: task.description,
		prompt: task.prompt,
		// Display-only relative path; the worker session itself uses the
		// resolved absolute task.cwd. Empty means "same as the parent".
		cwd: relative(parentCwd, task.cwd),
		model: `${task.model.provider}/${task.model.id}`,
		thinking: task.thinking,
		status: "queued",
		activities: [],
		liveText: "",
		finalOutput: "",
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
	const outputLimit = Math.min(SINGLE_OUTPUT_LIMIT, Math.max(1_024, perRunBudget - 7 * 1024));
	const bounded: SubagentDetails = {
		...details,
		runs: details.runs.map((run) => ({
			...run,
			prompt: boundText(run.prompt, 1_024),
			cwd: boundText(run.cwd, 1_024),
			currentActivity: run.currentActivity ? boundText(run.currentActivity, 512) : undefined,
			retry: run.retry ? { ...run.retry, error: boundText(run.retry.error, RETRY_ERROR_TEXT_LIMIT) } : undefined,
			activities: run.activities.slice(-DETAILS_ACTIVITY_LIMIT).map((activity) => ({
				...activity,
				summary: boundText(activity.summary, 256),
				resultSummary: activity.resultSummary ? boundText(activity.resultSummary, 256) : undefined,
			})),
			// liveText is a tail by construction: keep the newest lines, not the
			// head, or the transcript's live tail would freeze at the 1KB mark.
			liveText: tailText(run.liveText, 1_024),
			finalOutput: boundText(run.finalOutput, outputLimit),
			error: run.error ? boundText(run.error, 1_024) : undefined,
		})),
	};
	const fields: TextField[] = [];
	for (const run of bounded.runs) {
		fields.push(
			{
				get: () => run.prompt,
				set: (value) => {
					run.prompt = value;
				},
			},
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
				get: () => run.liveText,
				set: (value) => {
					run.liveText = value;
				},
			},
			{
				get: () => run.finalOutput,
				set: (value) => {
					run.finalOutput = value;
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
	if (runs.some((run) => run.status === "aborted")) return "aborted";
	if (runs.some((run) => run.status === "failed")) return "failed";
	if (runs.some((run) => run.status === "queued" || run.status === "running")) return "running";
	return "completed";
}

function statusText(details: SubagentDetails): string {
	const running = details.runs.filter((run) => run.status === "running").length;
	const queued = details.runs.filter((run) => run.status === "queued").length;
	const completed = details.runs.filter((run) => run.status === "completed").length;
	const failed = details.runs.filter((run) => run.status === "failed").length;
	const aborted = details.runs.filter((run) => run.status === "aborted").length;
	if (details.mode === "single") {
		const run = details.runs[0];
		if (run?.currentActivity) return run.currentActivity;
		if (
			!run ||
			(run.status === "running" && run.usage.turns === 0 && run.usage.toolUses === 0 && run.liveText.length === 0)
		) {
			return "Initializing…";
		}
		return run.status === "running" ? "Thinking…" : run.status;
	}
	const parts = [`${completed}/${details.runs.length} complete`];
	if (running) parts.push(`${running} running`);
	if (queued) parts.push(`${queued} queued`);
	if (failed) parts.push(`${failed} failed`);
	if (aborted) parts.push(`${aborted} aborted`);
	return parts.join(" · ");
}

function emitDetails(
	mode: SubagentDetails["mode"],
	runs: SubagentRunDetails[],
	startedAt: number,
	onUpdate: ((details: SubagentDetails) => void) | undefined,
): SubagentDetails {
	const details: SubagentDetails = {
		mode,
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
	const config = await loadSubagentConfig(options.agentDir);
	return Promise.all(
		tasks.map((task) =>
			resolveSubagentTask(task, options.parentCwd, options.agents, options.parent, options.agentDir, config),
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
	run.finalOutput = "";
	run.liveText = "";
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

async function runWithGate(
	task: ResolvedSubagentTask,
	run: SubagentRunDetails,
	options: SubagentInvocationOptions,
	onProgress: () => void,
): Promise<SubagentRunDetails> {
	onProgress();
	let release: (() => void) | undefined;
	try {
		release = await options.gate.acquire(options.signal);
		if (options.signal?.aborted) {
			run.status = "aborted";
			run.error = "Subagent was aborted while queued.";
			return run;
		}
		const baseDelayMs = options.taskRetryBaseDelayMs ?? TASK_RETRY_BASE_DELAY_MS;
		for (let attempt = 0; ; attempt++) {
			clearSubagentRetry(run);
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
			const delayMs = baseDelayMs * 2 ** attempt;
			resetRunForRetry(run, attempt + 1, TASK_RETRY_LIMIT, delayMs);
			onProgress();
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
}

function resultContent(details: SubagentDetails): string {
	if (details.mode === "single") {
		const run = details.runs[0];
		if (!run) return "Subagent produced no run.";
		if (run.status === "failed" || run.status === "aborted") {
			return boundText(
				`${run.status === "aborted" ? "Subagent aborted" : "Subagent failed"}: ${run.error ?? "unknown error"}${run.finalOutput ? `\n\nPartial response:\n${run.finalOutput}` : ""}`,
				SINGLE_OUTPUT_LIMIT,
			);
		}
		return run.finalOutput || EMPTY_OUTPUT;
	}
	const sections = details.runs.map((run) => {
		const output = run.finalOutput || run.error || EMPTY_OUTPUT;
		return `### ${run.description} (${run.agent}) — ${run.status}\n\n${boundText(output, PARALLEL_TASK_OUTPUT_LIMIT)}`;
	});
	return boundText(sections.join("\n\n---\n\n"), PARALLEL_OUTPUT_LIMIT);
}

function invocationMode(params: SubagentParams): { mode: SubagentDetails["mode"]; tasks: SubagentTask[] } {
	const provided: string[] = [];
	if (params.prompt != null) provided.push("prompt");
	if (params.tasks != null) provided.push("tasks");
	if (provided.length !== 1) {
		throw new Error(
			provided.length === 0
				? "Provide exactly one subagent mode: prompt (single task) or tasks (parallel tasks); none was provided."
				: `Provide exactly one subagent mode: received ${provided.join(", ")}. Keep one and set the unused mode fields to null or omit them.`,
		);
	}
	if (params.tasks != null) {
		return { mode: "parallel", tasks: params.tasks };
	}
	if (!params.description) throw new Error("description is required for single mode.");
	return {
		mode: "single",
		tasks: [
			{
				agent: params.agent,
				description: params.description,
				prompt: params.prompt!,
				cwd: params.cwd,
			},
		],
	};
}

// Cheap change detector: consecutive events that alter nothing user-visible
// skip the bounded-details serialization in emitDetails entirely.
function progressKey(runs: readonly SubagentRunDetails[]): string {
	return runs
		.map((run) => {
			const last = run.activities[run.activities.length - 1];
			return [
				run.status,
				run.currentActivity ?? "",
				run.activities.length,
				last?.status ?? "",
				last?.resultSummary ?? "",
				run.retry?.attempt ?? "",
				run.retry?.maxAttempts ?? "",
				run.retry?.deadline ?? "",
				run.retry?.error ?? "",
				run.liveText.length,
				run.liveText.slice(-24),
				run.finalOutput.length,
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
	const { mode, tasks } = invocationMode(options.params);
	const resolved = await resolveTasks(tasks, options);
	const runs = resolved.map((task, index) => createRun(task, index, options.parentCwd));
	const startedAt = Date.now();
	let latestDetails = emitDetails(mode, runs, startedAt, options.onUpdate);
	let lastProgressKey = progressKey(runs);
	const progress = () => {
		const key = progressKey(runs);
		if (key === lastProgressKey) return;
		lastProgressKey = key;
		latestDetails = emitDetails(mode, runs, startedAt, options.onUpdate);
	};

	if (mode === "single") {
		await runWithGate(resolved[0]!, runs[0]!, options, progress);
	} else {
		await Promise.all(resolved.map((task, index) => runWithGate(task, runs[index]!, options, progress)));
	}
	latestDetails = emitDetails(mode, runs, startedAt, undefined);
	latestDetails.endedAt = Date.now();
	const isError = isSubagentError(latestDetails);
	return {
		content: resultContent(latestDetails),
		details: boundSubagentDetails(latestDetails),
		usage: toNestedUsage(latestDetails.usage),
		isError,
	};
}

export function statusSummary(details: SubagentDetails): string {
	return statusText(details);
}
