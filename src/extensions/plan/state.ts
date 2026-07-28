/**
 * plan/state.ts — per-session plan-mode state, persisted as custom entries.
 *
 * State is conversation-backed like the todo extension: every transition is
 * appended as a `plan-mode` custom entry (never sent to the LLM), and lifecycle
 * handlers replay the current branch tail → head to restore. Custom entries are
 * copied on fork/clone, so `planFiles` keeps pointing at the right plan files
 * even though the forked session gets a new session id.
 *
 * State is keyed per session id: one Pi process can host several sessions over
 * its lifetime (resume, /tree switches), so callers re-point the active bucket
 * wherever ctx is in hand.
 */
import { PLAN_ENTRY_TYPE } from "./constants.ts";

export interface PlanSessionState {
	/** True from entry until the exit is fully applied (including a pending compaction). */
	planning: boolean;
	/**
	 * Full active-tool set snapshotted on entry; restored verbatim on exit.
	 * Empty for legacy entries (pre-snapshot `removedTools` shape) — replay
	 * re-derives a fresh snapshot for active planning, and an inactive legacy
	 * entry needs no restore beyond dropping exit_plan.
	 */
	toolSnapshot: string[];
	/** A compact-and-execute exit was approved and is waiting for agent_settled + compaction. */
	awaitingCompact: boolean;
	/** Absolute paths of plan files saved on this conversation branch. */
	planFiles: string[];
}

export const EMPTY_PLAN_STATE: PlanSessionState = {
	planning: false,
	toolSnapshot: [],
	awaitingCompact: false,
	planFiles: [],
};

const states = new Map<string, PlanSessionState>();
let activeSid = "";

/** Point the module at a session's state bucket. Call wherever ctx is in hand. */
export function setActivePlanSession(sid: string): void {
	activeSid = sid;
}

export function getPlanState(): PlanSessionState {
	return states.get(activeSid) ?? clonePlanState(EMPTY_PLAN_STATE);
}

export function replacePlanState(next: PlanSessionState): void {
	states.set(activeSid, clonePlanState(next));
}

/** Drop in-memory state for a session (call from session_shutdown). */
export function disposePlanSession(sid: string): void {
	if (!sid) return;
	states.delete(sid);
	if (activeSid === sid) activeSid = "";
}

export function clonePlanState(source: PlanSessionState): PlanSessionState {
	return {
		planning: source.planning,
		toolSnapshot: [...source.toolSnapshot],
		awaitingCompact: source.awaitingCompact,
		planFiles: [...source.planFiles],
	};
}

/**
 * Accepts both the current shape (`toolSnapshot`) and the legacy one
 * (`removedTools`), so branches recorded before the snapshot change replay.
 */
export function isPlanState(value: unknown): value is PlanSessionState {
	const parsed = parsePlanState(value);
	return parsed !== undefined;
}

function parsePlanState(value: unknown): PlanSessionState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.planning !== "boolean" || typeof record.awaitingCompact !== "boolean") return undefined;
	if (!Array.isArray(record.planFiles)) return undefined;
	const snapshot = Array.isArray(record.toolSnapshot)
		? record.toolSnapshot
		: Array.isArray(record.removedTools)
			? [] // Legacy entries recorded removals, not a snapshot; nothing to restore from.
			: undefined;
	if (!snapshot) return undefined;
	return {
		planning: record.planning,
		toolSnapshot: snapshot.filter((tool): tool is string => typeof tool === "string"),
		awaitingCompact: record.awaitingCompact,
		planFiles: record.planFiles.filter((path): path is string => typeof path === "string"),
	};
}

/**
 * Latest plan-mode entry on the current branch, or undefined when the branch
 * has none (lets callers distinguish "never used" from "explicitly exited").
 */
export function replayPlanFromBranch(ctx: {
	sessionManager: { getBranch(): Iterable<unknown> };
}): PlanSessionState | undefined {
	const branch = Array.from(ctx.sessionManager.getBranch());
	for (let i = branch.length - 1; i >= 0; i--) {
		const item = branch[i] as { type?: string; customType?: string; data?: unknown };
		if (item.type !== "custom" || item.customType !== PLAN_ENTRY_TYPE) continue;
		const parsed = parsePlanState(item.data);
		if (!parsed) continue;
		return parsed;
	}
	return undefined;
}
