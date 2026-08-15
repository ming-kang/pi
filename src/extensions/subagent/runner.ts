import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { emptyUsage, mergeUsage, toNestedUsage } from "./activity.ts";
import { boundSubagentDetails, resultContent } from "./budget.ts";
import { abortableSleep, createRunCancellation, type RunCancellation } from "./cancellation.ts";
import { MAX_CONCURRENCY, MAX_TASKS, TASK_RETRY_BASE_DELAY_MS, TASK_RETRY_LIMIT } from "./constants.ts";
import { type ParentModelContext, resolveSubagentTask } from "./resolve.ts";
import type { SubagentParams, SubagentTask } from "./schema.ts";
import { runSdkTask } from "./sdk-runner.ts";
import { loadSubagentConfig } from "./settings.ts";
import {
	createRunState,
	isSubagentError as isSubagentErrorSelector,
	reduceRun,
	type SubagentRunEvent,
	type SubagentRunState,
	statusOf,
	toRunDetails,
	versionSum,
} from "./state.ts";
import type { ResolvedSubagentTask, SubagentDetails, SubagentExecutionResult, SubagentUsage } from "./types.ts";

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
	/** Tool-call id of the invoking call; prefixes per-run ids for readability. */
	batchId?: string;
}

function aggregateUsage(runs: readonly SubagentRunState[]): SubagentUsage {
	const usage = emptyUsage();
	for (const run of runs) mergeUsage(usage, run.usage);
	return usage;
}

function emitDetails(
	runs: SubagentRunState[],
	startedAt: number,
	onUpdate: ((details: SubagentDetails) => void) | undefined,
): SubagentDetails {
	const details: SubagentDetails = {
		status: statusOf(runs),
		runs: runs.map(toRunDetails),
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
function shouldRetryTask(run: SubagentRunState): boolean {
	return (
		run.status === "failed" && run.usage.turns === 0 && run.usage.toolUses === 0 && isRetryableRunError(run.error)
	);
}

// The gate slot is held only while a worker session actually runs. Backoff
// waits outside the slot (release, sleep, reacquire) so a retrying task
// cannot starve queued tasks, and aborting during the wait settles the run
// without occupying the gate.
async function runWithGate(
	task: ResolvedSubagentTask,
	scope: RunCancellation,
	options: SubagentInvocationOptions,
	dispatch: (event: SubagentRunEvent) => void,
	getState: () => SubagentRunState,
	onProgress: () => void,
): Promise<void> {
	const baseDelayMs = options.taskRetryBaseDelayMs ?? TASK_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; ; attempt++) {
		dispatch({ type: "retry_started" });
		let release: (() => void) | undefined;
		let delayMs = 0;
		try {
			release = await options.gate.acquire(scope.signal);
			if (scope.signal.aborted) {
				dispatch({ type: "abort_while_queued", endedAt: Date.now() });
				return;
			}
			dispatch({ type: "slot_acquired", startedAt: Date.now() });
			await runSdkTask({
				task,
				scope,
				dispatch,
				modelRuntime: options.modelRuntime,
				agentDir: options.agentDir,
				projectTrusted: options.projectTrusted,
				onProgress,
			});
			const state = getState();
			if (attempt >= TASK_RETRY_LIMIT || scope.signal.aborted || !shouldRetryTask(state)) return;
			delayMs = baseDelayMs * 2 ** attempt;
			dispatch({
				type: "retry_scheduled",
				attempt: attempt + 1,
				maxAttempts: TASK_RETRY_LIMIT,
				deadline: Date.now() + delayMs,
				error: state.error,
			});
		} catch (error) {
			if (scope.signal.aborted) {
				dispatch({ type: "abort_while_queued", endedAt: Date.now() });
			} else {
				dispatch({
					type: "settle",
					verdict: "failed",
					report: "",
					error: error instanceof Error ? error.message : String(error),
					endedAt: Date.now(),
				});
			}
			return;
		} finally {
			release?.();
		}
		try {
			await abortableSleep(delayMs, scope);
		} catch {
			dispatch({ type: "abort_while_retrying", endedAt: Date.now() });
			return;
		}
	}
}

export async function runSubagentInvocation(options: SubagentInvocationOptions): Promise<SubagentExecutionResult> {
	// Defensive count check: the schema already enforces 1..MAX_TASKS, but
	// strict providers can bypass minItems, so validate before any work.
	const tasks = options.params.tasks ?? [];
	const resolved = await resolveTasks(tasks, options);
	const runs = resolved.map((task, index) => createRunState(task, index, options.batchId, options.parentCwd));
	const startedAt = Date.now();
	// Every run's cancellation scope exists and is registered before any
	// gate work starts, so a shutdown snapshot can never miss a queued task.
	const scopes = runs.map(() => createRunCancellation(options.signal));
	const unregisterScopes = scopes.map((scope) => options.registerAbort?.(scope.abort));
	let lastVersion = versionSum(runs);
	const progress = (): void => {
		const version = versionSum(runs);
		if (version === lastVersion) return;
		lastVersion = version;
		emitDetails(runs, startedAt, options.onUpdate);
	};
	const dispatch = (index: number, event: SubagentRunEvent): void => {
		runs[index] = reduceRun(runs[index]!, event);
		progress();
	};
	let latestDetails = emitDetails(runs, startedAt, options.onUpdate);

	// Every task runs concurrently through the shared gate; Promise.all keeps
	// result order identical to input order. There is no single-task branch:
	// one task is just a batch of one.
	try {
		await Promise.all(
			resolved.map((task, index) => {
				const dispatchToRun = (event: SubagentRunEvent): void => dispatch(index, event);
				return runWithGate(task, scopes[index]!, options, dispatchToRun, () => runs[index]!, progress);
			}),
		);
	} finally {
		for (const unregister of unregisterScopes) unregister?.();
		for (const scope of scopes) scope.dispose();
	}
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

export function isSubagentError(details: Pick<SubagentDetails, "status" | "runs">): boolean {
	return isSubagentErrorSelector(details);
}
