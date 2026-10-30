/**
 * Shared limits of the `tasks` tool.
 *
 * Numbers that more than one module needs live here so a change lands in one
 * place; read and wait limits, execution and retention belong to the core service.
 */

/** Finished tasks shown by `list` before the rest fold into a count. */
export const TASKS_LIST_FINISHED_SHOWN = 5;

/** Bounded output delta returned by a successful wait. */
export const TASKS_WAIT_DELTA_BYTES = 32 * 1024;

/** How long a foreground execution runs before the statusline advertises the detach key. */
export const TASKS_DETACH_HINT_DELAY_MS = 10_000;
