import { finiteLimit } from "../../utils/number.ts";
import { boundReadBytes } from "./output.ts";

/**
 * Shared observation-window limits, the one definition used by the runtime and the tasks tool.
 * Execution timeouts are configured separately by each executor.
 */
export const TASKS_WAIT_DEFAULT_MS = 20_000;
export const TASKS_WAIT_MIN_MS = 1_000;
export const TASKS_WAIT_MAX_MS = 10 * 60_000;
/** Floor for a model-requested read slice; the default and ceiling are TASK_READ_BYTES and TASK_RESULT_BYTES. */
export const TASKS_READ_MIN_BYTES = 256;

/** The wait window the runtime honours: any finite value up to the ceiling, including 0. */
export function boundWaitMs(waitMs: number | undefined): number {
	return finiteLimit(waitMs, TASKS_WAIT_DEFAULT_MS, TASKS_WAIT_MAX_MS);
}

/** The wait window a tool call runs, which the pending-call renderer also shows. */
export function clampWaitMs(waitMs: number | undefined): number {
	return Math.max(TASKS_WAIT_MIN_MS, boundWaitMs(waitMs));
}

/** The read size a tool call runs. */
export function clampReadBytes(bytes: number | undefined): number {
	return Math.max(TASKS_READ_MIN_BYTES, boundReadBytes(bytes));
}
