import { boundText } from "./activity.ts";
import { RETRY_ERROR_TEXT_LIMIT } from "./constants.ts";
import type { SubagentRunDetails } from "./types.ts";

export interface BeginSubagentRetryOptions {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	error: string;
}

export interface SubagentRetryView {
	attempt: number;
	maxAttempts: number;
	remainingSeconds: number;
	error: string;
}

function positiveInteger(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function retryError(error: string): string {
	const normalized = error.replace(/\s+/gu, " ").trim();
	return boundText(normalized, RETRY_ERROR_TEXT_LIMIT).replace(/\s+/gu, " ").trim();
}

export function beginSubagentRetry(run: SubagentRunDetails, options: BeginSubagentRetryOptions): void {
	const attempt = positiveInteger(options.attempt, 1);
	const maxAttempts = Math.max(attempt, positiveInteger(options.maxAttempts, attempt));
	const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0;
	run.retry = {
		attempt,
		maxAttempts,
		deadline: Date.now() + delayMs,
		error: retryError(options.error),
	};
	run.currentActivity = `Retrying (${attempt}/${maxAttempts})…`;
}

export function clearSubagentRetry(run: SubagentRunDetails): void {
	run.retry = undefined;
	if (run.currentActivity?.startsWith("Retrying")) run.currentActivity = undefined;
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
