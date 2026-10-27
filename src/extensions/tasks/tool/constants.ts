/**
 * Shared limits of the `tasks` tool.
 *
 * Numbers that more than one module needs live here so a change lands in one
 * place; execution and retention limits belong to the core service.
 */

/** Default and floor for a `read` slice; the ceiling is the core's TASK_RESULT_BYTES. */
export const TASKS_LOGS_DEFAULT_BYTES = 8 * 1024;
export const TASKS_LOGS_MIN_BYTES = 256;

/** Finished tasks shown by `list` before the rest fold into a count. */
export const TASKS_LIST_FINISHED_SHOWN = 5;

/** Bounded output delta returned by a successful wait. */
export const TASKS_WAIT_DELTA_BYTES = 32 * 1024;

/** Wait-window bounds shared by execution and the pending-call renderer. */
export const TASKS_WAIT_DEFAULT_MS = 20_000;
export const TASKS_WAIT_MIN_MS = 1_000;
export const TASKS_WAIT_MAX_MS = 60_000;

/** How long a foreground execution runs before the statusline advertises the detach key. */
export const TASKS_DETACH_HINT_DELAY_MS = 10_000;
