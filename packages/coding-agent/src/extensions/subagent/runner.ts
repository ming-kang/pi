import type { ModelRuntime } from "../../core/model-runtime.ts";
import { boundText, emptyUsage, mergeUsage, toNestedUsage } from "./activity.ts";
import {
	CHAIN_HANDOFF_LIMIT,
	DETAILS_ACTIVITY_LIMIT,
	DETAILS_OUTPUT_LIMIT,
	ERROR_TEXT_LIMIT,
	MAX_CONCURRENCY,
	MAX_TASKS,
	PARALLEL_OUTPUT_LIMIT,
	PARALLEL_TASK_OUTPUT_LIMIT,
	SINGLE_OUTPUT_LIMIT,
} from "./constants.ts";
import { type ParentModelContext, resolveSubagentTask } from "./resolve.ts";
import type { SubagentParams, SubagentTask } from "./schema.ts";
import { runSdkTask } from "./sdk-runner.ts";
import type {
	AgentDefinition,
	ResolvedSubagentTask,
	SubagentDetails,
	SubagentExecutionResult,
	SubagentRunDetails,
	SubagentUsage,
} from "./types.ts";

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
	configAgentDir: string;
	signal?: AbortSignal;
	gate: ConcurrencyGate;
	onUpdate?: (details: SubagentDetails) => void;
	registerAbort?: (abort: () => Promise<void>) => () => void;
}

function runId(index: number): string {
	return `subagent-${index + 1}`;
}

function createRun(task: ResolvedSubagentTask, index: number, step?: number): SubagentRunDetails {
	return {
		id: runId(index),
		agent: task.agent.name,
		agentSource: task.agent.source,
		description: task.description,
		prompt: task.prompt,
		cwd: task.cwd,
		model: `${task.model.provider}/${task.model.id}`,
		thinking: task.thinking,
		status: "queued",
		activities: [],
		liveText: "",
		finalOutput: "",
		usage: emptyUsage(),
		step,
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
			activities: run.activities.slice(-DETAILS_ACTIVITY_LIMIT).map((activity) => ({
				...activity,
				summary: boundText(activity.summary, 256),
				resultSummary: activity.resultSummary ? boundText(activity.resultSummary, 256) : undefined,
			})),
			liveText: boundText(run.liveText, 1_024),
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
		return run?.currentActivity ?? run?.status ?? "starting";
	}
	if (details.mode === "chain") {
		const current = details.runs.find((run) => run.status === "running" || run.status === "queued");
		return current
			? `Step ${current.step ?? 1}/${details.runs.length} · ${current.currentActivity ?? current.agent}`
			: `${completed}/${details.runs.length} steps complete`;
	}
	return `${completed}/${details.runs.length} complete · ${running} running · ${queued} queued${failed ? ` · ${failed} failed` : ""}${aborted ? ` · ${aborted} aborted` : ""}`;
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

function replacePrevious(prompt: string, previous: string): string {
	return prompt.replace(/\{previous\}/gu, boundText(previous, CHAIN_HANDOFF_LIMIT));
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
	return Promise.all(
		tasks.map((task) =>
			resolveSubagentTask(task, options.parentCwd, options.agents, options.parent, options.configAgentDir),
		),
	);
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
		return await runSdkTask({
			task,
			run,
			modelRuntime: options.modelRuntime,
			agentDir: options.agentDir,
			signal: options.signal,
			onProgress,
			registerAbort: options.registerAbort,
		});
	} catch (error) {
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
		return run.finalOutput || "(no output)";
	}
	if (details.mode === "chain") {
		const failed = details.runs.find((run) => run.status === "failed" || run.status === "aborted");
		if (failed)
			return boundText(
				`Chain stopped at step ${failed.step ?? "?"} (${failed.agent}): ${failed.error ?? "unknown error"}`,
				ERROR_TEXT_LIMIT,
			);
		const last = details.runs[details.runs.length - 1];
		return last?.finalOutput || "(no output)";
	}
	const sections = details.runs.map((run) => {
		const output = run.finalOutput || run.error || "(no output)";
		return `### ${run.agent} · ${run.status}\n\n${boundText(output, PARALLEL_TASK_OUTPUT_LIMIT)}`;
	});
	return boundText(`Parallel results\n\n${sections.join("\n\n---\n\n")}`, PARALLEL_OUTPUT_LIMIT);
}

function invocationMode(params: SubagentParams): { mode: SubagentDetails["mode"]; tasks: SubagentTask[] } {
	const provided: string[] = [];
	if (params.prompt != null) provided.push("prompt");
	if (params.tasks != null) provided.push("tasks");
	if (params.chain != null) provided.push("chain");
	if (provided.length !== 1) {
		throw new Error(
			provided.length === 0
				? "Provide exactly one subagent mode: prompt (single), tasks (parallel), or chain (sequential); none was provided."
				: `Provide exactly one subagent mode: received ${provided.join(", ")}. Keep one and set the unused mode fields to null or omit them.`,
		);
	}
	if (params.tasks != null) {
		return { mode: "parallel", tasks: params.tasks };
	}
	if (params.chain != null) {
		return { mode: "chain", tasks: params.chain };
	}
	if (params.prompt == null) {
		throw new Error("Provide exactly one subagent mode: prompt (single), tasks (parallel), or chain (sequential).");
	}
	if (!params.description) throw new Error("description is required for single mode.");
	return {
		mode: "single",
		tasks: [
			{
				agent: params.agent,
				description: params.description,
				prompt: params.prompt,
				cwd: params.cwd,
			},
		],
	};
}

export async function runSubagentInvocation(options: SubagentInvocationOptions): Promise<SubagentExecutionResult> {
	const { mode, tasks } = invocationMode(options.params);
	const resolved = await resolveTasks(tasks, options);
	const runs = resolved.map((task, index) => createRun(task, index, mode === "chain" ? index + 1 : undefined));
	const startedAt = Date.now();
	let latestDetails = emitDetails(mode, runs, startedAt, options.onUpdate);
	const progress = () => {
		latestDetails = emitDetails(mode, runs, startedAt, options.onUpdate);
	};

	if (mode === "single") {
		await runWithGate(resolved[0]!, runs[0]!, options, progress);
	} else if (mode === "parallel") {
		await Promise.all(resolved.map((task, index) => runWithGate(task, runs[index]!, options, progress)));
	} else {
		let previous = "";
		for (let index = 0; index < resolved.length; index++) {
			if (options.signal?.aborted) {
				runs[index]!.status = "aborted";
				runs[index]!.error = "Skipped because the parent subagent call was aborted.";
				continue;
			}
			const task = { ...resolved[index]!, prompt: replacePrevious(resolved[index]!.prompt, previous) };
			await runWithGate(task, runs[index]!, options, progress);
			if (runs[index]!.status !== "completed") {
				for (let skipped = index + 1; skipped < runs.length; skipped++) {
					runs[skipped]!.status = options.signal?.aborted ? "aborted" : "failed";
					runs[skipped]!.error = `Skipped because chain step ${index + 1} did not complete.`;
				}
				break;
			}
			previous = runs[index]!.finalOutput;
		}
	}
	latestDetails = emitDetails(mode, runs, startedAt, undefined);
	latestDetails.endedAt = Date.now();
	const isError = latestDetails.status === "failed" || latestDetails.status === "aborted";
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
