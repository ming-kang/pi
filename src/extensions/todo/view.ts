import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { TodoItem, TodoParams, TodoState, TodoStatus } from "./schema.ts";
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

function isTodoStatus(value: string): value is TodoStatus {
	return Object.hasOwn(STATUS_MARK, value);
}

function formatCallHeadline(args: TodoCallArgs | undefined, theme: Theme): string {
	const action = callText(args?.action);
	const parts = [theme.fg("toolTitle", theme.bold(action ? `todo ${action}` : "todo"))];

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

	push("description", callText(args?.description));
	push("activeForm", callText(args?.activeForm));
	push("owner", callText(args?.owner));
	for (const key of EDGE_PARAMS) {
		const ids = callIds(args?.[key]);
		if (ids.length) push(key, ids.map((id) => `#${id}`).join(","));
	}
	if (args?.includeDeleted === true) push("includeDeleted", "true");
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

export function formatCommandList(state: TodoState): string {
	const visible = visibleTodos(state);
	if (!visible.length) return "No todos yet.";
	const lines: string[] = [];
	for (const status of ["in_progress", "pending", "completed"] as const) {
		const group = visible.filter((item) => item.status === status).sort(byIdAsc);
		if (!group.length) continue;
		lines.push(status);
		for (const item of group) {
			const active = item.status === "in_progress" && item.activeForm ? ` (${item.activeForm})` : "";
			const owner = item.owner ? ` @${item.owner}` : "";
			const unresolved = unresolvedDependencyIds(state, item);
			const deps = unresolved.length ? ` blocked by ${unresolved.map((id) => `#${id}`).join(",")}` : "";
			lines.push(`  ${STATUS_MARK[item.status]} #${item.id} ${item.subject}${active}${owner}${deps}`);
		}
	}
	return lines.join("\n");
}
