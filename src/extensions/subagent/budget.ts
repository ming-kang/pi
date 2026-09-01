import { isDisplayableActivity } from "./activity.ts";
import {
	DETAILS_ACTIVITY_LIMIT,
	DETAILS_OUTPUT_LIMIT,
	DISPLAY_ACTIVITY_LIMIT,
	RETRY_ERROR_TEXT_LIMIT,
	TASK_OUTPUT_LIMIT,
	TOTAL_OUTPUT_LIMIT,
} from "./constants.ts";
import { boundText } from "./text.ts";
import type { SubagentDetails, SubagentRunDetails } from "./types.ts";

const EMPTY_OUTPUT = "(Subagent completed but returned no output.)";

// Pass-2 (adversarial) accounting: the bounded non-report payload is
// measured exactly (JSON escaping included), the residual is split across
// runs, and a worst-case JSON-escape factor of 6x (\\uXXXX control escapes)
// keeps the final serialization under the limit by construction — no shrink
// loop, at most three serializations.
const BATCH_RESERVE_BYTES = 1 * 1024;
const JSON_ESCAPE_FACTOR = 6;

export interface BudgetPlan {
	/** Per-run share of the persisted details budget. */
	perRunDetails: number;
	/** Report cap inside the persisted details for a single run. */
	perRunDetailsReport: number;
	/** Model-facing report budget per numbered task section. */
	perTaskReport: number;
	/** Model-facing total report budget across every section. */
	totalReport: number;
}

export function planBudgets(taskCount: number): BudgetPlan {
	const count = Math.max(1, taskCount);
	const perRunDetails = Math.max(1_024, Math.floor((DETAILS_OUTPUT_LIMIT - 8 * 1024) / count));
	// Fair per-task report budget: the total cap is split evenly after
	// reserving room for the numbered section headings and separators, capped
	// per task.
	const headingReserve = Math.min(256 * count, Math.floor(TOTAL_OUTPUT_LIMIT / 4));
	const fairShare = Math.floor((TOTAL_OUTPUT_LIMIT - headingReserve) / count);
	return {
		perRunDetails,
		perRunDetailsReport: Math.min(TASK_OUTPUT_LIMIT, Math.max(1_024, perRunDetails - 7 * 1024)),
		perTaskReport: Math.min(TASK_OUTPUT_LIMIT, Math.max(2_048, fairShare)),
		totalReport: TOTAL_OUTPUT_LIMIT,
	};
}

function detailsSize(details: SubagentDetails): number {
	return Buffer.byteLength(JSON.stringify(details), "utf8");
}

// Keep the normal newest-activity tail while guaranteeing that synthetic
// compaction entries cannot evict the three real tool calls the expanded UI
// promises to show. The count and byte caps remain unchanged.
function selectDetailsActivities(activities: SubagentRunDetails["activities"]): SubagentRunDetails["activities"] {
	if (activities.length <= DETAILS_ACTIVITY_LIMIT) return activities;

	const required = new Set<number>();
	for (let index = activities.length - 1; index >= 0 && required.size < DISPLAY_ACTIVITY_LIMIT; index--) {
		const activity = activities[index];
		if (activity && isDisplayableActivity(activity)) required.add(index);
	}

	const selected = new Set<number>();
	for (let index = activities.length - DETAILS_ACTIVITY_LIMIT; index < activities.length; index++) selected.add(index);
	for (const index of required) selected.add(index);

	const ordered = [...selected].sort((left, right) => left - right);
	while (ordered.length > DETAILS_ACTIVITY_LIMIT) {
		const removable = ordered.findIndex((index) => !required.has(index));
		if (removable === -1) break;
		ordered.splice(removable, 1);
	}
	return ordered.map((index) => activities[index]!);
}

function boundRuns(details: SubagentDetails, reportLimit: number): SubagentDetails {
	return {
		...details,
		runs: details.runs.map((run) => ({
			...run,
			cwd: boundText(run.cwd, 1_024),
			currentActivity: run.currentActivity ? boundText(run.currentActivity, 512) : undefined,
			retry: run.retry ? { ...run.retry, error: boundText(run.retry.error, RETRY_ERROR_TEXT_LIMIT) } : undefined,
			activities: selectDetailsActivities(run.activities).map((activity) => ({
				...activity,
				summary: boundText(activity.summary, 256),
				resultSummary: activity.resultSummary ? boundText(activity.resultSummary, 256) : undefined,
			})),
			report: boundText(run.report, reportLimit),
			error: run.error ? boundText(run.error, 1_024) : undefined,
		})),
	};
}

// Bounds the persisted details payload. Pass 1 uses the same optimistic
// per-run budget as the historical shrink loop's starting point, which every
// realistic batch satisfies without shrinking reports. Only adversarial
// payloads (e.g. every field at its cap in a full 8-run batch) fall through
// to pass 2, which caps reports to the measured residual share.
export function boundSubagentDetails(details: SubagentDetails): SubagentDetails {
	const plan = planBudgets(details.runs.length);
	const optimistic = boundRuns(details, plan.perRunDetailsReport);
	if (detailsSize(optimistic) <= DETAILS_OUTPUT_LIMIT) return optimistic;
	const count = Math.max(1, details.runs.length);
	const nonReportBytes = detailsSize(boundRuns(details, 0));
	const residual = DETAILS_OUTPUT_LIMIT - nonReportBytes - BATCH_RESERVE_BYTES;
	// Factor 2 covers realistic escaping (quotes, backslashes, newlines); the
	// measured result still wins when it fits.
	const likely = Math.min(plan.perRunDetailsReport, Math.max(0, Math.floor(residual / count / 2)));
	const likelyBounded = boundRuns(details, likely);
	if (detailsSize(likelyBounded) <= DETAILS_OUTPUT_LIMIT) return likelyBounded;
	// Worst-case \\uXXXX control escapes: under the limit by construction.
	const reportLimit = Math.min(
		plan.perRunDetailsReport,
		Math.max(0, Math.floor(residual / count / JSON_ESCAPE_FACTOR)),
	);
	return boundRuns(details, reportLimit);
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
export function resultContent(details: SubagentDetails): string {
	const perTaskBudget = planBudgets(details.runs.length).perTaskReport;
	const sections = details.runs.map((run, index) => {
		return `${reportSectionTitle(run, index)}\n\n${boundText(reportSectionBody(run), perTaskBudget)}`;
	});
	return boundText(sections.join("\n\n---\n\n"), TOTAL_OUTPUT_LIMIT);
}
