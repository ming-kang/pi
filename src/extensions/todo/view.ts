import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { LIST_DISPLAY_MAX_ITEMS } from "./constants.ts";
import {
	TODO_DETAILS_SCHEMA_VERSION,
	type TodoItem,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./schema.ts";
import { unresolvedDependencyIds } from "./state.ts";

export const STATUS_MARK: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
	deleted: "[-]",
};

export const STATUS_COLOR: Record<TodoStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

const OVERLAY_BODY_MAX_ITEMS = 10;

function visibleTodos(state: TodoState): TodoItem[] {
	return state.items.filter((item) => item.status !== "deleted");
}

export function hasVisibleOverlayItems(state: TodoState, hiddenCompleted: ReadonlySet<number>): boolean {
	return visibleTodos(state).some((item) => item.status !== "completed" || !hiddenCompleted.has(item.id));
}

function todoCounts(items: TodoItem[]): { total: number; pending: number; inProgress: number; completed: number } {
	const counts = { total: items.length, pending: 0, inProgress: 0, completed: 0 };
	for (const item of items) {
		if (item.status === "pending") counts.pending++;
		else if (item.status === "in_progress") counts.inProgress++;
		else if (item.status === "completed") counts.completed++;
	}
	return counts;
}

export function renderOverlayLines(
	state: TodoState,
	theme: Theme,
	width: number,
	hiddenCompleted: ReadonlySet<number>,
): string[] {
	const allVisible = visibleTodos(state);
	const visible = allVisible.filter((item) => item.status !== "completed" || !hiddenCompleted.has(item.id));
	if (!visible.length) return [];

	const counts = todoCounts(allVisible);
	const hasActive = visible.some((item) => item.status === "pending" || item.status === "in_progress");
	const heading = `${theme.fg(hasActive ? "accent" : "dim", "Todos")} ${theme.fg("dim", `(${counts.completed}/${counts.total})`)}`;
	const lines = [truncateToWidth(heading, width, "...")];

	const showIds = visible.some((item) => item.blockedBy?.length);
	const body = chooseOverlayItems(visible, state, OVERLAY_BODY_MAX_ITEMS);
	for (const item of body.items) {
		lines.push(truncateToWidth(`  ${formatOverlayItem(item, state, theme, showIds)}`, width, "..."));
	}
	if (body.hidden.length > 0) {
		lines.push(truncateToWidth(theme.fg("dim", `  ${formatHiddenSummary(body.hidden)}`), width, "..."));
	}
	lines.push("");
	return lines;
}

function byIdAsc(first: TodoItem, second: TodoItem): number {
	return first.id - second.id;
}

function overlayPriority(state: TodoState, item: TodoItem): number {
	if (item.status === "in_progress") return 0;
	if (item.status === "pending" && unresolvedDependencyIds(state, item).length === 0) return 1;
	if (item.status === "pending") return 2;
	return 3; // Completed items here are recent; older ones are hidden by TodoOverlay.
}

function chooseOverlayItems(
	items: TodoItem[],
	state: TodoState,
	maxBody: number,
): { items: TodoItem[]; hidden: TodoItem[] } {
	const prioritized = [...items].sort((first, second) => {
		const priorityDelta = overlayPriority(state, first) - overlayPriority(state, second);
		return priorityDelta || byIdAsc(first, second);
	});
	if (prioritized.length <= maxBody) return { items: prioritized, hidden: [] };

	const shown = prioritized.slice(0, Math.max(1, maxBody - 1));
	return { items: shown, hidden: prioritized.slice(shown.length) };
}

function formatHiddenSummary(items: TodoItem[]): string {
	const counts = todoCounts(items);
	const parts: string[] = [];
	if (counts.inProgress) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending) parts.push(`${counts.pending} pending`);
	if (counts.completed) parts.push(`${counts.completed} completed`);
	return `+${items.length} more${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function formatOverlayItem(item: TodoItem, state: TodoState, theme: Theme, showId: boolean): string {
	let text = theme.fg(STATUS_COLOR[item.status], STATUS_MARK[item.status]);
	if (showId) text += ` ${theme.fg("accent", `#${item.id}`)}`;
	const subject =
		item.status === "completed" ? theme.strikethrough(theme.fg("dim", item.subject)) : theme.fg("text", item.subject);
	text += ` ${subject}`;
	if (item.status === "in_progress" && item.activeForm) text += ` ${theme.fg("dim", `(${item.activeForm})`)}`;

	const unresolved = unresolvedDependencyIds(state, item);
	if (unresolved.length) {
		text += ` ${theme.fg("dim", `blocked by ${unresolved.map((id) => `#${id}`).join(",")}`)}`;
		if (item.status === "pending" || item.status === "in_progress")
			text += ` ${theme.fg("warning", "(deps incomplete)")}`;
	}
	return text;
}

// ---- tool call rendering ----------------------------------------------------
// Collapsed todo calls join the `todo` tool group, so each row must survive as a
// single headline with no result beneath it (ToolGroupComponent drops results and
// appends one shared expand hint). Args come straight off the wire and can be
// partial while the call streams, so every field is read defensively.

type TodoCallArgs = Partial<Record<keyof TodoParams, unknown>>;

const EDGE_PARAMS = ["blockedBy", "addBlockedBy", "removeBlockedBy", "addBlocks", "removeBlocks"] as const;

function callText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function callId(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function callIds(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : [];
}

function callArrayLength(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

function callBatchSubjects(value: unknown): string {
	if (!Array.isArray(value)) return "";
	const subjects: string[] = [];
	for (const item of value.slice(0, 3)) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const subject = callText((item as Record<string, unknown>).subject);
		if (subject) subjects.push(subject);
	}
	return subjects.join("; ");
}

function callNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isTodoStatus(value: string): value is TodoStatus {
	return Object.hasOwn(STATUS_MARK, value);
}

function formatCallHeadline(args: TodoCallArgs | undefined, theme: Theme): string {
	const action = callText(args?.action);
	const parts = [theme.fg("toolTitle", theme.bold(action ? `todo ${action}` : "todo"))];

	if (action === "create_many") {
		const count = callArrayLength(args?.items);
		if (count !== undefined) parts.push(theme.fg("dim", `${count} tasks`));
	}

	const id = callId(args?.id);
	if (id !== undefined) parts.push(theme.fg("accent", `#${id}`));

	const status = callText(args?.status);
	if (status && isTodoStatus(status)) parts.push(theme.fg(STATUS_COLOR[status], status));

	const subject = callText(args?.subject);
	if (subject) parts.push(theme.fg("text", subject));

	// Dependency-only updates would otherwise render as a bare `todo update #3`.
	const hasEdgeChange = EDGE_PARAMS.some((key) => callIds(args?.[key]).length > 0);
	if (!status && !subject && hasEdgeChange) parts.push(theme.fg("dim", "dependencies"));

	return parts.join(" ");
}

function formatCallDetails(args: TodoCallArgs | undefined, theme: Theme): string[] {
	const lines: string[] = [];
	const push = (label: string, value: string) => {
		if (value) lines.push(theme.fg("dim", `${label}: ${value}`));
	};

	const action = callText(args?.action);
	if (action === "create_many") {
		const count = callArrayLength(args?.items);
		if (count !== undefined) {
			const subjects = callBatchSubjects(args?.items);
			push("batch", `${count} tasks${subjects ? ` (${subjects})` : ""}`);
		}
	}

	push("description", callText(args?.description));
	push("activeForm", callText(args?.activeForm));
	push("owner", callText(args?.owner));
	for (const key of EDGE_PARAMS) {
		const ids = callIds(args?.[key]);
		if (ids.length) push(key, ids.map((id) => `#${id}`).join(","));
	}
	if (args?.includeDeleted === true) push("includeDeleted", "true");
	const limit = callId(args?.limit);
	if (limit !== undefined) push("limit", String(limit));
	const afterId = callId(args?.afterId);
	if (afterId !== undefined) push("afterId", String(afterId));
	push("query", callText(args?.query));
	if (args?.unblockedOnly === true) push("unblockedOnly", "true");
	if (args?.confirm === true) push("confirm", "true");
	const expectedCount = callNonNegativeInteger(args?.expectedCount);
	if (expectedCount !== undefined) push("expectedCount", String(expectedCount));
	const metadata = args?.metadata;
	if (metadata && typeof metadata === "object") push("metadata", Object.keys(metadata).join(","));
	return lines;
}

/**
 * One-line call summary when collapsed; the same headline plus the parameters
 * the result never echoes (description, activeForm, dependencies) when expanded.
 */
export function formatTodoCall(args: TodoCallArgs | undefined, theme: Theme, expanded: boolean): string {
	const headline = formatCallHeadline(args, theme);
	if (!expanded) return headline;
	return [headline, ...formatCallDetails(args, theme)].join("\n");
}

interface TodoGroupRenderContext {
	isError: boolean;
	isPartial: boolean;
	result?: AgentToolResult<unknown>;
}

interface GroupTodoDetails {
	action: string;
	operation: Record<string, unknown>;
	items: unknown;
}

const GROUP_FAILURE_MAX_LENGTH = 120;
const GROUP_MAX_IDS = 20;
const GROUP_MAX_SNAPSHOT_ITEMS = 10_000;
const TODO_ACTIONS = new Set(["create", "create_many", "update", "list", "get", "delete", "clear"]);

function safeRecord(value: unknown): Record<string, unknown> | undefined {
	try {
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function safeValue(record: Record<string, unknown>, key: string): unknown {
	try {
		return record[key];
	} catch {
		return undefined;
	}
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function groupDetails(value: unknown): GroupTodoDetails | undefined {
	const details = safeRecord(value);
	if (!details || safeValue(details, "schemaVersion") !== TODO_DETAILS_SCHEMA_VERSION) return undefined;
	const action = safeString(safeValue(details, "action"));
	if (!action || !TODO_ACTIONS.has(action)) return undefined;
	const operation = safeRecord(safeValue(details, "operation"));
	if (!operation || safeValue(operation, "kind") !== action) return undefined;
	return { action, operation, items: safeValue(details, "items") };
}

function groupPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function groupIds(value: unknown): number[] | undefined {
	try {
		if (!Array.isArray(value) || value.length === 0 || value.length > GROUP_MAX_IDS) return undefined;
		const ids: number[] = [];
		for (const valueAtIndex of value) {
			const id = groupPositiveInteger(valueAtIndex);
			if (id === undefined) return undefined;
			ids.push(id);
		}
		return ids;
	} catch {
		return undefined;
	}
}

function groupNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function formatGroupStatusCounts(value: unknown, resultCount: unknown): string | undefined {
	const count = groupNonNegativeInteger(resultCount);
	if (count === undefined) return undefined;
	if (count === 0) return "no tasks";

	const rawCounts = safeRecord(value);
	if (!rawCounts) return undefined;
	const parts: string[] = [];
	let total = 0;
	for (const status of ["pending", "in_progress", "completed", "deleted"] as const) {
		const statusCount = groupNonNegativeInteger(safeValue(rawCounts, status));
		if (statusCount === undefined) continue;
		total += statusCount;
		if (statusCount > 0) parts.push(`${statusCount} ${status}`);
	}
	return total === count && parts.length ? parts.join(", ") : undefined;
}

function groupItemStatus(value: unknown, id: number): TodoStatus | undefined {
	try {
		if (!Array.isArray(value) || value.length > GROUP_MAX_SNAPSHOT_ITEMS) return undefined;
		for (const rawItem of value) {
			const item = safeRecord(rawItem);
			if (!item || safeValue(item, "id") !== id) continue;
			const status = safeString(safeValue(item, "status"));
			return status && isTodoStatus(status) ? status : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function formatGroupFailure(result: AgentToolResult<unknown> | undefined): string {
	try {
		for (const block of result?.content.slice(0, 8) ?? []) {
			if (block.type !== "text" || typeof block.text !== "string") continue;
			const reason = block.text
				.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			if (!reason) continue;
			return reason.length > GROUP_FAILURE_MAX_LENGTH ? `${reason.slice(0, GROUP_FAILURE_MAX_LENGTH - 1)}…` : reason;
		}
	} catch {
		// Tool results can come from historical or third-party sources.
	}
	return "tool failed";
}

function formatTodoGroupSuccess(result: AgentToolResult<unknown>): string | undefined {
	const details = groupDetails(result.details);
	if (!details) return undefined;

	switch (details.action) {
		case "create":
		case "create_many": {
			const ids = groupIds(safeValue(details.operation, "ids"));
			if (!ids || (details.action === "create" && ids.length !== 1)) return undefined;
			return `todo created ${ids.length} ${ids.length === 1 ? "task" : "tasks"} ${ids.map((id) => `#${id}`).join(", ")}`;
		}
		case "update": {
			const id = groupPositiveInteger(safeValue(details.operation, "id"));
			const status = safeString(safeValue(details.operation, "status"));
			return id !== undefined && status && isTodoStatus(status) ? `todo updated #${id} ${status}` : undefined;
		}
		case "list": {
			const counts = formatGroupStatusCounts(
				safeValue(details.operation, "statusCounts"),
				safeValue(details.operation, "resultCount"),
			);
			return counts === undefined ? undefined : `todo list: ${counts}`;
		}
		case "get": {
			const id = groupPositiveInteger(safeValue(details.operation, "id"));
			const status = id === undefined ? undefined : groupItemStatus(details.items, id);
			return status ? `todo get #${id} ${status}` : undefined;
		}
		case "delete": {
			const id = groupPositiveInteger(safeValue(details.operation, "id"));
			return id === undefined ? undefined : `todo deleted #${id}`;
		}
		case "clear": {
			const count = callNonNegativeInteger(safeValue(details.operation, "count"));
			return count === undefined ? undefined : `todo cleared ${count} ${count === 1 ? "task" : "tasks"}`;
		}
	}
}

/** Compact result-aware summary used only by collapsed todo tool groups. */
export function formatTodoGroupCall(
	args: TodoCallArgs | undefined,
	theme: Theme,
	context: TodoGroupRenderContext,
): string {
	if (context.isError) {
		return `${formatTodoCall(args, theme, false)} ${theme.fg("error", `failed: ${formatGroupFailure(context.result)}`)}`;
	}
	if (!context.isPartial && context.result) {
		const summary = formatTodoGroupSuccess(context.result);
		if (summary) return theme.fg("toolTitle", summary);
	}
	return formatTodoCall(args, theme, false);
}

export function formatCommandList(state: TodoState): string {
	const visible = visibleTodos(state);
	if (!visible.length) return "No todos yet.";
	const lines: string[] = [];
	let shown = 0;
	for (const status of ["in_progress", "pending", "completed"] as const) {
		const group = visible.filter((item) => item.status === status).sort(byIdAsc);
		if (!group.length || shown >= LIST_DISPLAY_MAX_ITEMS) continue;
		lines.push(status);
		for (const item of group) {
			if (shown >= LIST_DISPLAY_MAX_ITEMS) break;
			const active = item.status === "in_progress" && item.activeForm ? ` (${item.activeForm})` : "";
			const owner = item.owner ? ` @${item.owner}` : "";
			const unresolved = unresolvedDependencyIds(state, item);
			const deps = unresolved.length ? ` blocked by ${unresolved.map((id) => `#${id}`).join(",")}` : "";
			lines.push(`  ${STATUS_MARK[item.status]} #${item.id} ${item.subject}${active}${owner}${deps}`);
			shown++;
		}
	}
	if (visible.length > shown) {
		lines.push(`… and ${visible.length - shown} more; use todo list with limit and afterId to page.`);
	}
	return lines.join("\n");
}
