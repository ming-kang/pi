import { boundReadBytes } from "./output.ts";
import type { TaskSnapshot } from "./types.ts";

/** Shared read limits, the one definition used by the runtime and the tasks tool. */
/** Floor for a model-requested read slice; the default and ceiling are TASK_READ_BYTES and TASK_RESULT_BYTES. */
export const TASKS_READ_MIN_BYTES = 256;

/** The read size a tool call runs. */
export function clampReadBytes(bytes: number | undefined): number {
	return Math.max(TASKS_READ_MIN_BYTES, boundReadBytes(bytes));
}

/**
 * The end a read starts from when the caller names none, the one definition every read
 * and projection shares: a report's beginning is its summary, a log's end is its outcome.
 */
export function defaultReadMode(task: Pick<TaskSnapshot, "output">): "head" | "tail" {
	return task.output === "report" ? "head" : "tail";
}
