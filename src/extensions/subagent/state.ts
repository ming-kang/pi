import { relative } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	activitySummary,
	addUsage,
	compactionError,
	compactionSummary,
	emptyUsage,
	resultSummary,
} from "./activity.ts";
import {
	ACTIVITY_LIMIT,
	ACTIVITY_TEXT_LIMIT,
	COMPACTION_ACTIVITY_ID,
	ERROR_TEXT_LIMIT,
	RETRY_ERROR_TEXT_LIMIT,
	TASK_OUTPUT_LIMIT,
} from "./constants.ts";
import { modelId } from "./model-selection.ts";
import { boundText } from "./text.ts";
import type { ResolvedSubagentTask, SubagentDetails, SubagentRunDetails, ToolActivity } from "./types.ts";

/**
 * Mutable-run state plus an internal revision counter. All transitions go
 * through {@link reduceRun}; the batch runner compares version sums instead
 * of diffing rendered fields.
 */
export interface SubagentRunState extends SubagentRunDetails {
	/** Monotonic per-run revision; bumped by every applied event. */
	version: number;
}

/** The adapter layer's only output and the reducer's only input. */
export type SubagentRunEvent =
	| { type: "slot_acquired"; startedAt: number }
	| {
			type: "retry_scheduled";
			attempt: number;
			maxAttempts: number;
			deadline: number;
			error: string | undefined;
	  }
	| { type: "retry_started" }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; deadline: number; error: string }
	| { type: "auto_retry_end" }
	| { type: "turn_end" }
	| { type: "assistant_message_settled"; usage: Usage | undefined }
	| { type: "tool_started"; toolCallId: string; toolName: string; args: unknown; startedAt: number }
	| { type: "tool_updated"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_ended"; toolCallId: string; result: unknown; isError: boolean; endedAt: number }
	| { type: "compaction_started"; startedAt: number }
	| {
			type: "compaction_ended";
			tokensBefore: number | undefined;
			tokensAfter: number | undefined;
			error: string | undefined;
			endedAt: number;
	  }
	| {
			type: "settle";
			verdict: "completed" | "failed" | "aborted";
			report: string;
			error: string | undefined;
			endedAt: number;
	  }
	| { type: "abort_while_queued"; endedAt: number }
	| { type: "abort_while_retrying"; endedAt: number };

function runId(batchId: string | undefined, index: number): string {
	if (!batchId) return `subagent-${index + 1}`;
	// toolCallIds are provider-shaped ("call_ABC..."); keep the readable
	// prefix, then disambiguate truncated collisions with a deterministic
	// hash of the full id.
	const sanitized = batchId.replace(/[^A-Za-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "");
	const hash = hashRunId(batchId);
	const prefix = sanitized.length > 24 ? `${sanitized.slice(0, 24)}-${hash}` : sanitized || `run-${hash}`;
	return `${prefix}-${index + 1}`;
}

function hashRunId(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

export function createRunState(
	task: ResolvedSubagentTask,
	index: number,
	batchId: string | undefined,
	parentCwd: string,
): SubagentRunState {
	return {
		id: runId(batchId, index),
		agent: task.agent.name,
		description: task.description,
		// Display-only relative path; the worker session itself uses the
		// resolved absolute task.cwd. Empty means "same as the parent".
		cwd: relative(parentCwd, task.cwd),
		model: modelId(task.model),
		thinking: task.thinking,
		status: "queued",
		activities: [],
		report: "",
		usage: emptyUsage(),
		version: 0,
	};
}

/** Strips internal fields for projection into the public details shape. */
export function toRunDetails(state: SubagentRunState): SubagentRunDetails {
	const { version: _version, ...details } = state;
	return details;
}

// The live "current activity" line is derived, never imperative: a pending
// retry wins, then the most recent still-running tool. This is what keeps a
// parallel batch's line correct when tools end out of order.
export function deriveCurrentActivity(state: SubagentRunState): string | undefined {
	if (state.status === "completed" || state.status === "failed" || state.status === "aborted") return undefined;
	if (state.retry) return `Retrying (${state.retry.attempt}/${state.retry.maxAttempts})…`;
	for (let index = state.activities.length - 1; index >= 0; index--) {
		const activity = state.activities[index];
		if (activity?.status === "running") return activity.summary;
	}
	return undefined;
}

function positiveInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function retryError(error: string): string {
	const normalized = error.replace(/\s+/gu, " ").trim();
	return boundText(normalized, RETRY_ERROR_TEXT_LIMIT).replace(/\s+/gu, " ").trim();
}

function makeRetry(attempt: number, maxAttempts: number, deadline: number, error: string): SubagentRunState["retry"] {
	const normalizedAttempt = positiveInteger(attempt, 1);
	return {
		attempt: normalizedAttempt,
		maxAttempts: Math.max(normalizedAttempt, positiveInteger(maxAttempts, normalizedAttempt)),
		deadline,
		error: retryError(error),
	};
}

// The in-memory activity log keeps the newest entries within both the count
// and text budgets; a bounded O(ACTIVITY_LIMIT) rescan per event replaces
// incremental byte bookkeeping. Exported for direct budget tests: real
// events bound every summary, so the text-budget eviction is otherwise
// purely defensive.
export function appendActivity(activities: ToolActivity[], activity: ToolActivity): void {
	activities.push(activity);
	while (activities.length > ACTIVITY_LIMIT) activities.shift();
	while (
		activities.reduce((total, item) => total + item.summary.length + (item.resultSummary?.length ?? 0), 0) >
		ACTIVITY_TEXT_LIMIT
	) {
		if (activities.length <= 1) break;
		activities.shift();
	}
}

function isTerminal(state: SubagentRunState): boolean {
	return state.status === "completed" || state.status === "failed" || state.status === "aborted";
}

function withRevision(state: SubagentRunState, mutate: (draft: SubagentRunState) => void): SubagentRunState {
	const draft: SubagentRunState = {
		...state,
		activities: state.activities.map((activity) => ({ ...activity })),
		usage: { ...state.usage },
	};
	mutate(draft);
	draft.version = state.version + 1;
	return draft;
}

function clearRetry(draft: SubagentRunState): void {
	draft.retry = undefined;
}

/**
 * Pure transition function; timestamps and deadlines arrive in the event.
 * Events applied after a terminal verdict are ignored (settle is idempotent)
 * — except retry_scheduled, the one sanctioned reopening transition.
 */
export function reduceRun(state: SubagentRunState, event: SubagentRunEvent): SubagentRunState {
	if (isTerminal(state) && event.type !== "retry_scheduled") return state;
	return withRevision(state, (draft) => {
		// Cross-cutting pre-hook: every event clears the retry view except
		// retry_scheduled (which sets it) and the two abort-terminal events
		// (which clear it explicitly in their own body).
		if (event.type !== "retry_scheduled") clearRetry(draft);
		applyEvent(draft, event);
		// Cross-cutting post-hook: derive the live activity line from the
		// new state. Terminal abort events override this to undefined.
		draft.currentActivity = deriveCurrentActivity(draft);
	});
}

// ─── Individual event handlers ───────────────────────────────────────────────
// Each handler mutates the draft in place. Cross-cutting clearRetry and
// deriveCurrentActivity are handled by the dispatch layer above.

function handleSlotAcquired(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "slot_acquired" }>,
): void {
	draft.status = "running";
	draft.startedAt = event.startedAt;
}

function handleRetryScheduled(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "retry_scheduled" }>,
): void {
	// Full reset: only runs that produced nothing are retried, so nothing of
	// value is discarded. The retry view stays visible through the backoff.
	const error = draft.error ?? "Subagent failed before retry.";
	draft.status = "queued";
	draft.error = undefined;
	draft.startedAt = undefined;
	draft.endedAt = undefined;
	draft.report = "";
	draft.activities = [];
	draft.usage = emptyUsage();
	draft.retry = makeRetry(event.attempt, event.maxAttempts, event.deadline, error);
}

function handleRetryStarted(draft: SubagentRunState): void {
	// No-op beyond the cross-cutting clearRetry already applied.
	void draft;
}

function handleAutoRetryStart(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "auto_retry_start" }>,
): void {
	draft.retry = makeRetry(event.attempt, event.maxAttempts, event.deadline, event.error);
}

function handleAutoRetryEnd(draft: SubagentRunState): void {
	// No-op beyond the cross-cutting clearRetry already applied.
	void draft;
}

function handleTurnEnd(draft: SubagentRunState): void {
	draft.usage.turns++;
}

function handleAssistantMessageSettled(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "assistant_message_settled" }>,
): void {
	addUsage(draft.usage, event.usage);
}

function handleToolStarted(draft: SubagentRunState, event: Extract<SubagentRunEvent, { type: "tool_started" }>): void {
	draft.usage.toolUses++;
	appendActivity(draft.activities, {
		id: event.toolCallId,
		toolName: event.toolName,
		summary: activitySummary(event.toolName, event.args),
		status: "running",
		startedAt: event.startedAt,
	});
}

function handleToolUpdated(draft: SubagentRunState, event: Extract<SubagentRunEvent, { type: "tool_updated" }>): void {
	const summary = activitySummary(event.toolName, event.args);
	const activity =
		draft.activities.find((candidate) => candidate.id === event.toolCallId && candidate.status === "running") ??
		[...draft.activities].reverse().find((candidate) => candidate.status === "running");
	if (activity) activity.summary = summary;
}

function handleToolEnded(draft: SubagentRunState, event: Extract<SubagentRunEvent, { type: "tool_ended" }>): void {
	const activity = draft.activities.find((candidate) => candidate.id === event.toolCallId);
	if (activity && activity.status === "running") {
		activity.status = event.isError ? "failed" : "succeeded";
		activity.endedAt = event.endedAt;
		activity.resultSummary = resultSummary(event.result) || undefined;
	}
}

function handleCompactionStarted(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "compaction_started" }>,
): void {
	appendActivity(draft.activities, {
		id: COMPACTION_ACTIVITY_ID,
		toolName: COMPACTION_ACTIVITY_ID,
		summary: "Compacting context…",
		status: "running",
		startedAt: event.startedAt,
	});
}

function handleCompactionEnded(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "compaction_ended" }>,
): void {
	const activity = [...draft.activities]
		.reverse()
		.find((candidate) => candidate.id === COMPACTION_ACTIVITY_ID && candidate.status === "running");
	if (activity) {
		activity.status = event.error ? "failed" : "succeeded";
		activity.endedAt = event.endedAt;
		activity.summary = compactionSummary(event.tokensBefore, event.tokensAfter);
		activity.resultSummary = event.error ? compactionError(event.error) : undefined;
	}
}

function handleSettle(draft: SubagentRunState, event: Extract<SubagentRunEvent, { type: "settle" }>): void {
	draft.status = event.verdict;
	draft.report = boundText(event.report, TASK_OUTPUT_LIMIT);
	draft.error = event.error ? boundText(event.error, ERROR_TEXT_LIMIT) : undefined;
	draft.endedAt = event.endedAt;
	draft.retry = undefined;
}

function handleAbortWhileQueued(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "abort_while_queued" }>,
): void {
	draft.status = "aborted";
	draft.error = "Subagent was aborted while queued.";
	draft.endedAt = event.endedAt;
	draft.retry = undefined;
}

function handleAbortWhileRetrying(
	draft: SubagentRunState,
	event: Extract<SubagentRunEvent, { type: "abort_while_retrying" }>,
): void {
	draft.status = "aborted";
	draft.error = "Subagent was aborted while waiting to retry.";
	draft.endedAt = event.endedAt;
	draft.retry = undefined;
}

function applyEvent(draft: SubagentRunState, event: SubagentRunEvent): void {
	switch (event.type) {
		case "slot_acquired":
			handleSlotAcquired(draft, event);
			break;
		case "retry_scheduled":
			handleRetryScheduled(draft, event);
			break;
		case "retry_started":
			handleRetryStarted(draft);
			break;
		case "auto_retry_start":
			handleAutoRetryStart(draft, event);
			break;
		case "auto_retry_end":
			handleAutoRetryEnd(draft);
			break;
		case "turn_end":
			handleTurnEnd(draft);
			break;
		case "assistant_message_settled":
			handleAssistantMessageSettled(draft, event);
			break;
		case "tool_started":
			handleToolStarted(draft, event);
			break;
		case "tool_updated":
			handleToolUpdated(draft, event);
			break;
		case "tool_ended":
			handleToolEnded(draft, event);
			break;
		case "compaction_started":
			handleCompactionStarted(draft, event);
			break;
		case "compaction_ended":
			handleCompactionEnded(draft, event);
			break;
		case "settle":
			handleSettle(draft, event);
			break;
		case "abort_while_queued":
			handleAbortWhileQueued(draft, event);
			break;
		case "abort_while_retrying":
			handleAbortWhileRetrying(draft, event);
			break;
	}
}

export function versionSum(runs: readonly SubagentRunState[]): number {
	let total = 0;
	for (const run of runs) total += run.version;
	return total;
}

export function statusOf(runs: readonly SubagentRunDetails[]): SubagentDetails["status"] {
	if (runs.length === 0) return "running";
	// Active beats terminal: any queued or running run keeps the batch
	// "running" regardless of what the others have settled to.
	if (runs.some((run) => run.status === "queued" || run.status === "running")) return "running";
	if (runs.every((run) => run.status === "completed")) return "completed";
	if (runs.some((run) => run.status === "completed")) return "partial";
	if (runs.every((run) => run.status === "aborted")) return "aborted";
	return "failed";
}

export function isSubagentError(details: Pick<SubagentDetails, "status" | "runs">): boolean {
	if (details.status !== "failed" && details.status !== "aborted") return false;
	// A batch with any successful run is a partial result, not an error:
	// per-run status is already reported in the content sections.
	return !details.runs.some((run) => run.status === "completed");
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

export function statusSummary(details: SubagentDetails): string {
	return statusText(details);
}

export interface SubagentRetryView {
	attempt: number;
	maxAttempts: number;
	remainingSeconds: number;
	error: string;
}

export function getSubagentRetryView(run: SubagentRunDetails, now = Date.now()): SubagentRetryView | undefined {
	const retry = run.retry;
	if (!retry || !Number.isFinite(retry.deadline)) return undefined;
	const attempt = positiveInteger(retry.attempt, 1);
	const maxAttempts = Math.max(attempt, positiveInteger(retry.maxAttempts, attempt));
	const currentTime = Number.isFinite(now) ? now : retry.deadline;
	return {
		attempt,
		maxAttempts,
		remainingSeconds: Math.max(0, Math.ceil((retry.deadline - currentTime) / 1000)),
		error: retryError(typeof retry.error === "string" ? retry.error : ""),
	};
}
