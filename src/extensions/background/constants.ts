/**
 * background — shared limits and identity.
 *
 * Numbers that more than one module needs live here so a change lands in one
 * place; execution and retention limits belong to the core service.
 */

/** Historical extension-owned completion/stall messages. */
export const BG_NOTIFICATION_TYPE = "background-task";
/** Session-owned completions; model content and delivery are unchanged by rendering. */
export const BG_COMPLETION_TYPE = "background-completion";

/** Default and floor for a `read` slice; the ceiling is truncate.ts's DEFAULT_MAX_BYTES. */
export const BG_LOGS_DEFAULT_BYTES = 8 * 1024;
export const BG_LOGS_MIN_BYTES = 256;

/** Finished tasks shown by `list` before the rest fold into a count. */
export const BG_LIST_FINISHED_SHOWN = 5;

/** Bounded output delta returned by a successful wait. */
export const BG_WAIT_DELTA_BYTES = 32 * 1024;

/** Wait-window bounds shared by execution and the pending-call renderer. */
export const BG_WAIT_DEFAULT_MS = 20_000;
export const BG_WAIT_MIN_MS = 1_000;
export const BG_WAIT_MAX_MS = 60_000;
