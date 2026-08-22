/**
 * todo/view.ts — v2 presentation: the one-line above-editor widget renderer,
 * tool call/group renderers, the /todos list formatter, and model-facing
 * result text. Wire input (args, details, snapshots) is read defensively and
 * bounded so partial or hostile input cannot grow output without limit.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	TODO_MAX_BATCH_ITEMS,
	TODO_MAX_DESCRIPTION_LENGTH,
	TODO_MAX_ITEMS,
	TODO_MAX_SUBJECT_LENGTH,
} from "./constants.ts";
import {
	TODO_DETAILS_SCHEMA_VERSION,
	type TodoChange,
	type TodoItem,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "./schema.ts";

export const STATUS_MARK: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
};

const STATUS_COLOR: Record<TodoStatus, "dim" | "warning" | "success"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
};

const STATUS_RANK: Record<TodoStatus, number> = {
	in_progress: 0,
	pending: 1,
	completed: 2,
};

// --- One-line widget --------------------------------------------------------

const WIDGET_HEADER_SEPARATOR = " · ";
const WIDGET_ITEM_SEPARATOR = "  ";

/** True while any open task exists; the widget is registered only in that case. */
export function hasOpenTodos(state: TodoState): boolean {
	return state.items.some((item) => item.status === "pending" || item.status === "in_progress");
}

/** Status counts across the whole list. */
function widgetCounts(state: TodoState): { active: number; pending: number; completed: number } {
	const counts = { active: 0, pending: 0, completed: 0 };
	for (const item of state.items) {
		if (item.status === "in_progress") counts.active++;
		else if (item.status === "pending") counts.pending++;
		else counts.completed++;
	}
	return counts;
}

function widgetSegment(item: TodoItem, subject: string, theme: Theme): string {
	return `${theme.fg(STATUS_COLOR[item.status], STATUS_MARK[item.status])} ${theme.fg("accent", `#${item.id}`)} ${theme.fg("text", subject)}`;
}

function widgetLine(header: string, segments: string[], overflow: string): string {
	const body = [...segments, ...(overflow ? [overflow] : [])].join(WIDGET_ITEM_SEPARATOR);
	return body ? `${header}${WIDGET_HEADER_SEPARATOR}${body}` : header;
}

/** Long overflow with counts (zero parts omitted), e.g. `+4 more (4 completed)`. */
function widgetOverflowLong(remaining: number, counts: { active: number; pending: number; completed: number }): string {
	const parts = [
		counts.active > 0 ? `${counts.active} active` : "",
		counts.pending > 0 ? `${counts.pending} pending` : "",
		counts.completed > 0 ? `${counts.completed} completed` : "",
	].filter(Boolean);
	return `+${remaining} more${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** One-line widget: `Todos 2/6 · [>] #4 s  [ ] #5 s  +N more (…)`; completed tasks are hidden but counted in the overflow. */
export function renderWidgetLine(state: TodoState, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const items = state.items;
	const candidates = items
		.filter((item) => item.status !== "completed")
		.sort((first, second) => STATUS_RANK[first.status] - STATUS_RANK[second.status] || first.id - second.id);
	if (candidates.length === 0) return [];

	const total = items.length;
	const completed = items.filter((item) => item.status === "completed").length;
	const header = `${theme.fg("accent", "Todos")} ${theme.fg("dim", `${completed}/${total}`)}`;
	const counts = widgetCounts(state);
	const shown: Array<{ item: TodoItem; subject: string }> = [];
	let overflow = "";

	// Best overflow for a trial segment set: the long counts form when it fits,
	// the short `+N more` form otherwise, undefined when even that overflows.
	const bestOverflow = (trial: Array<{ item: TodoItem; subject: string }>): string | undefined => {
		const remaining = total - trial.length;
		const segments = trial.map((entry) => widgetSegment(entry.item, entry.subject, theme));
		const activeShown = trial.some((entry) => entry.item.status === "in_progress") ? 1 : 0;
		const hidden: typeof counts = {
			active: counts.active - activeShown,
			pending: counts.pending - (trial.length - activeShown),
			completed: counts.completed,
		};
		if (remaining <= 0) return visibleWidth(widgetLine(header, segments, "")) <= safeWidth ? "" : undefined;
		const long = theme.fg("dim", widgetOverflowLong(remaining, hidden));
		if (visibleWidth(widgetLine(header, segments, long)) <= safeWidth) return long;
		const short = theme.fg("dim", `+${remaining} more`);
		return visibleWidth(widgetLine(header, segments, short)) <= safeWidth ? short : undefined;
	};

	// Extreme narrow widths: the best summary that fits, then the bare header.
	const fallback = (): string[] => {
		const best = bestOverflow([]);
		if (best !== undefined) return [widgetLine(header, [], best)];
		if (visibleWidth(header) <= safeWidth) return [header];
		return [truncateToWidth(header, safeWidth, "…")];
	};

	// Segments are added whole, active first then pending by id, while the
	// line keeps fitting; only the active subject may be truncated.
	for (const candidate of candidates) {
		const best = bestOverflow([...shown, { item: candidate, subject: candidate.subject }]);
		if (best !== undefined) {
			shown.push({ item: candidate, subject: candidate.subject });
			overflow = best;
			continue;
		}
		if (candidate.status !== "in_progress") break;
		const remaining = total - shown.length - 1;
		const suffix = remaining > 0 ? `${WIDGET_ITEM_SEPARATOR}+${remaining} more` : "";
		const prefix = `${header}${WIDGET_HEADER_SEPARATOR}${widgetSegment(candidate, "", theme)}${suffix}`;
		const available = safeWidth - visibleWidth(prefix);
		if (available < 1) return fallback();
		shown.push({ item: candidate, subject: truncateToWidth(candidate.subject, available, "…") });
		overflow = bestOverflow(shown) ?? "";
	}

	if (shown.length === 0) return fallback();

	const segments = shown.map((entry) => widgetSegment(entry.item, entry.subject, theme));
	const line = widgetLine(header, segments, overflow);
	// Safety net: the visible width always stays within the terminal width.
	return [visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "…")];
}

// --- Full list (used by /todos and the model-facing list result) ------------

/** `Todos: X in progress, Y pending, Z completed` header plus two-line tasks. */
function formatTodoList(state: TodoState): string {
	if (state.items.length === 0) return "No todos.";
	const counts = widgetCounts(state);
	const lines = [`Todos: ${counts.active} in progress, ${counts.pending} pending, ${counts.completed} completed`];
	const items = [...state.items].sort(
		(first, second) => STATUS_RANK[first.status] - STATUS_RANK[second.status] || first.id - second.id,
	);
	for (const item of items) {
		lines.push(`${STATUS_MARK[item.status]} #${item.id} ${item.subject}`);
		lines.push(`    ${item.description}`);
	}
	return lines.join("\n");
}

/** /todos command output: full list, subject line plus indented description per task. */
export const formatCommandList = formatTodoList;

/** Model-facing text for one completed todo call; bounded by list and input limits. */
export function formatTodoContent(change: TodoChange, state: TodoState): string {
	switch (change.kind) {
		case "create": {
			const parts = change.ids.map((id) => {
				const item = state.items.find((entry) => entry.id === id);
				return item ? `#${item.id}: ${item.subject}` : `#${id}`;
			});
			const noun = change.ids.length === 1 ? "task" : "tasks";
			return `Created ${change.ids.length} ${noun}${parts.length ? `: ${parts.join("; ")}` : ""}`;
		}
		case "update": {
			const item = state.items.find((entry) => entry.id === change.id);
			const subject = item ? `: ${item.subject}` : "";
			const transition = change.from === change.to ? "" : ` (${change.from} -> ${change.to})`;
			const demoted = change.demotedId !== undefined ? `; demoted #${change.demotedId} to pending` : "";
			return `Updated #${change.id}${transition}${subject}${demoted}`;
		}
		case "list":
			return formatTodoList(state);
		case "delete": {
			const noun = change.removed.length === 1 ? "task" : "tasks";
			const parts = change.removed.map((entry) => `#${entry.id}: ${entry.subject}`);
			return `Deleted ${change.removed.length} ${noun}${parts.length ? `: ${parts.join("; ")}` : ""}`;
		}
	}
}

// --- Tool calls and collapsed group summaries -------------------------------

// Collapsed todo calls join the `todo` group as one headline per row. Args can
// be partial or hostile and details may come from any source, so one defensive
// reading family (record/field/text/id/status/array) serves both renderers.
// Output stays bounded: batches at 20, subjects at 160, descriptions at 500.

type TodoCallArgs = Partial<Record<keyof TodoParams, unknown>>;

const CALL_ITEMS_MAX = TODO_MAX_BATCH_ITEMS;
const CALL_SUBJECT_PREVIEW_COUNT = 2;
const CALL_SUBJECT_PREVIEW_WIDTH = 72;
const CALL_DESCRIPTION_PREVIEW_LENGTH = 120;
const GROUP_FAILURE_MAX_LENGTH = 120;
const TODO_ACTIONS = new Set(["create", "update", "list", "delete"]);

/** Record-like read; proxies that throw on inspection are treated as absent. */
function safeRecord(value: unknown): Record<string, unknown> | undefined {
	try {
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Field read that never throws, even for exotic objects with throwing getters. */
function safeValue(record: Record<string, unknown> | undefined, key: string): unknown {
	try {
		return record?.[key];
	} catch {
		return undefined;
	}
}

function safeString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Trimmed, whitespace-collapsed, length-clipped text (empty when absent). */
function clipText(value: unknown, max: number): string {
	return safeString(value)?.trim().replace(/\s+/g, " ").slice(0, max) ?? "";
}

const safeSubject = (value: unknown): string => clipText(value, TODO_MAX_SUBJECT_LENGTH);
const safeDescription = (value: unknown): string => clipText(value, TODO_MAX_DESCRIPTION_LENGTH);

function safeId(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function safeStatus(value: unknown): TodoStatus | undefined {
	const status = safeString(value);
	if (status === "pending" || status === "in_progress" || status === "completed") return status;
	return undefined;
}

function readArray(value: unknown, limit = CALL_ITEMS_MAX): { values: unknown[]; length: number } | undefined {
	try {
		if (!Array.isArray(value)) return undefined;
		const length = value.length;
		const values: unknown[] = [];
		for (let index = 0; index < Math.min(length, limit); index++) {
			try {
				values.push(value[index]);
			} catch {
				values.push(undefined);
			}
		}
		return { values, length };
	} catch {
		return undefined;
	}
}

/** Id lists: lenient for delete args (invalid entries drop), strict for result changes (any invalid entry rejects). */
function readIds(value: unknown, strict: boolean): number[] | undefined {
	const array = readArray(value);
	if (strict && (!array || array.length === 0 || array.length > CALL_ITEMS_MAX)) return undefined;
	if (!array) return strict ? undefined : [];
	const ids: number[] = [];
	for (const entry of array.values) {
		const id = safeId(entry);
		if (id === undefined) {
			if (strict) return undefined;
			continue;
		}
		ids.push(id);
	}
	return ids;
}

/** Create args: sparse or invalid entries drop; the batch caps at the maximum. */
function batchItems(value: unknown): Array<{ subject: string; description: string }> {
	const result: Array<{ subject: string; description: string }> = [];
	for (const raw of readArray(value)?.values ?? []) {
		const item = safeRecord(raw);
		if (!item) continue;
		result.push({
			subject: safeSubject(safeValue(item, "subject")),
			description: safeDescription(safeValue(item, "description")),
		});
	}
	return result;
}

function descriptionPreview(value: string): string {
	const text = value.replace(/\s+/g, " ");
	return text.length > CALL_DESCRIPTION_PREVIEW_LENGTH
		? `${text.slice(0, CALL_DESCRIPTION_PREVIEW_LENGTH - 1)}…`
		: text;
}

/** At most two subjects, each truncated to the preview width, plus `+N more`. */
function formatSubjectPreview(subjects: string[], total: number): string {
	// Filter before slicing so an empty subject (streaming args) does not consume
	// a preview slot.
	const shown = subjects
		.filter(Boolean)
		.slice(0, CALL_SUBJECT_PREVIEW_COUNT)
		.map((subject) => truncateToWidth(subject, CALL_SUBJECT_PREVIEW_WIDTH, "…"));
	if (!shown.length) return "";
	const hidden = Math.max(0, total - shown.length);
	return `${shown.join(", ")}${hidden ? `, +${hidden} more` : ""}`;
}

/** v2 details guard shared by the call and group renderers. */
function todoDetails(value: unknown): { change: Record<string, unknown>; state: Record<string, unknown> } | undefined {
	const details = safeRecord(value);
	if (!details || safeValue(details, "schemaVersion") !== TODO_DETAILS_SCHEMA_VERSION) return undefined;
	const change = safeRecord(safeValue(details, "change"));
	const state = safeRecord(safeValue(details, "state"));
	if (!change || !state) return undefined;
	const kind = safeString(safeValue(change, "kind"));
	if (!kind || !TODO_ACTIONS.has(kind)) return undefined;
	return { change, state };
}

/** Result ids for an expanded create, only when they match the shown items. */
function createResultIds(result: AgentToolResult<unknown> | undefined, count: number): number[] | undefined {
	const details = todoDetails(result?.details);
	if (!details || safeString(safeValue(details.change, "kind")) !== "create") return undefined;
	const ids = readIds(safeValue(details.change, "ids"), true);
	return ids?.length === count ? ids : undefined;
}

/** Removed entries for an expanded delete; absent until a v2 delete result arrives. */
function deleteResultRemoved(
	result: AgentToolResult<unknown> | undefined,
): Array<{ id: number; subject: string }> | undefined {
	const details = todoDetails(result?.details);
	if (!details || safeString(safeValue(details.change, "kind")) !== "delete") return undefined;
	return removedEntries(safeValue(details.change, "removed"));
}

/** Headline plus the parameters the result never echoes as detail lines. */
function formatCallParts(
	args: TodoCallArgs | undefined,
	theme: Theme,
	result?: AgentToolResult<unknown>,
): { headline: string; details: string[] } {
	const action = clipText(args?.action, TODO_MAX_SUBJECT_LENGTH);
	const verb = TODO_ACTIONS.has(action) ? action : undefined;
	const headline: string[] = [theme.fg("toolTitle", theme.bold(verb ? `todo ${verb}` : "todo"))];
	const details: string[] = [];

	if (verb === "create") {
		const items = batchItems(args?.items);
		const rawCount = readArray(args?.items)?.length;
		if (rawCount !== undefined) {
			const count = Math.min(rawCount, CALL_ITEMS_MAX);
			headline.push(theme.fg("dim", `${count} ${count === 1 ? "task" : "tasks"}`));
			const subjects = items.map((item) => item.subject);
			const preview = formatSubjectPreview(subjects, count);
			if (preview) headline.push(theme.fg("dim", "·"), theme.fg("text", preview));
		}
		const ids = createResultIds(result, items.length);
		for (const [index, item] of items.entries()) {
			const marker = ids ? theme.fg("accent", `#${ids[index]}`) : theme.fg("accent", `${index + 1}.`);
			details.push(item.subject ? `${marker} ${theme.fg("text", item.subject)}` : marker);
			if (item.description) details.push(`    ${theme.fg("dim", descriptionPreview(item.description))}`);
		}
	} else if (verb === "update") {
		const id = safeId(args?.id);
		if (id !== undefined) headline.push(theme.fg("accent", `#${id}`));
		const status = safeStatus(args?.status);
		if (status) headline.push(theme.fg(STATUS_COLOR[status], status));
		const subject = safeSubject(args?.subject);
		if (subject) headline.push(theme.fg("text", truncateToWidth(subject, CALL_SUBJECT_PREVIEW_WIDTH, "…")));
		const description = safeDescription(args?.description);
		if (description) details.push(`    ${theme.fg("dim", descriptionPreview(description))}`);
	} else if (verb === "delete") {
		const ids = readIds(args?.ids, false) ?? [];
		if (ids.length) headline.push(theme.fg("accent", ids.map((id) => `#${id}`).join(", ")));
		// The headline already carries the ids, so details only earn their line
		// once the result names what was actually removed.
		for (const entry of deleteResultRemoved(result) ?? []) {
			details.push(`${theme.fg("accent", `#${entry.id}`)} ${theme.fg("text", entry.subject)}`);
		}
	}

	return { headline: headline.join(" "), details };
}

/** One-line call summary when collapsed; headline plus details when expanded. */
export function formatTodoCall(
	args: TodoCallArgs | undefined,
	theme: Theme,
	expanded: boolean,
	result?: AgentToolResult<unknown>,
): string {
	const { headline, details } = formatCallParts(args, theme, result);
	return !expanded || details.length === 0 ? headline : [headline, ...details].join("\n");
}

/** Id -> item index plus status counts over the v2 snapshot (one defensive walk). */
function stateIndex(state: Record<string, unknown>):
	| {
			byId: Map<number, Record<string, unknown>>;
			counts: { inProgress: number; pending: number; completed: number };
	  }
	| undefined {
	const array = readArray(safeValue(state, "items"), TODO_MAX_ITEMS);
	if (!array || array.length > TODO_MAX_ITEMS) return undefined;
	const byId = new Map<number, Record<string, unknown>>();
	const counts = { inProgress: 0, pending: 0, completed: 0 };
	for (const raw of array.values) {
		const item = safeRecord(raw);
		if (!item) continue;
		const id = safeId(safeValue(item, "id"));
		if (id !== undefined && !byId.has(id)) byId.set(id, item);
		const status = safeStatus(safeValue(item, "status"));
		if (status === "in_progress") counts.inProgress++;
		else if (status === "pending") counts.pending++;
		else if (status === "completed") counts.completed++;
	}
	return { byId, counts };
}

function stateSubject(map: Map<number, Record<string, unknown>>, id: number): string {
	const item = map.get(id);
	return item ? safeSubject(safeValue(item, "subject")) : "";
}

/** Deleted entries: one invalid or empty entry rejects the whole list. */
function removedEntries(value: unknown): Array<{ id: number; subject: string }> | undefined {
	const array = readArray(value);
	if (!array || array.length === 0 || array.length > CALL_ITEMS_MAX) return undefined;
	const removed: Array<{ id: number; subject: string }> = [];
	for (const raw of array.values) {
		const id = safeId(safeValue(safeRecord(raw), "id"));
		const subject = safeSubject(safeValue(safeRecord(raw), "subject"));
		if (id === undefined || !subject) return undefined;
		removed.push({ id, subject });
	}
	return removed;
}

function formatTodoGroupSuccess(
	args: TodoCallArgs | undefined,
	theme: Theme,
	result: AgentToolResult<unknown>,
): string | undefined {
	const parsed = todoDetails(result.details);
	if (!parsed) return undefined;
	const { change, state } = parsed;
	const verb = (word: string) => theme.fg("toolTitle", `todo ${word}`);
	const withPreview = (word: string, ids: number[], subjects: string[]): string => {
		const text = formatSubjectPreview(subjects, subjects.length);
		const consecutive = ids.length > 1 && ids.every((id, index) => id === ids[0] + index);
		const rendered = consecutive ? `#${ids[0]}–#${ids.at(-1)}` : ids.map((id) => `#${id}`).join(", ");
		const base = `${verb(word)} ${theme.fg("accent", rendered)}`;
		return text ? `${base}${theme.fg("dim", " · ")}${theme.fg("text", text)}` : base;
	};
	const kind = safeString(safeValue(change, "kind"));

	if (kind === "create") {
		const ids = readIds(safeValue(change, "ids"), true);
		const index = stateIndex(state);
		if (!ids || !index) return undefined;
		const subjects = ids.map((id) => stateSubject(index.byId, id));
		return withPreview("created", ids, subjects);
	}
	if (kind === "update") {
		const id = safeId(safeValue(change, "id"));
		const index = stateIndex(state);
		if (id === undefined || !index) return undefined;
		const to = safeStatus(safeValue(change, "to"));
		const demotedId = safeId(safeValue(change, "demotedId"));
		const parts = [verb("updated"), theme.fg("accent", `#${id}`)];
		if (to) parts.push(theme.fg(STATUS_COLOR[to], to));
		const subject = stateSubject(index.byId, id) || safeSubject(args?.subject) || "";
		if (subject) parts.push(theme.fg("text", truncateToWidth(subject, CALL_SUBJECT_PREVIEW_WIDTH, "…")));
		if (demotedId !== undefined) parts.push(theme.fg("dim", `· demoted #${demotedId}`));
		return parts.join(" ");
	}
	if (kind === "list") {
		const counts = stateIndex(state)?.counts;
		if (!counts) return undefined;
		const parts: string[] = [];
		if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
		if (counts.pending > 0) parts.push(`${counts.pending} pending`);
		if (counts.completed > 0) parts.push(`${counts.completed} completed`);
		return `${verb("list")}: ${theme.fg("dim", parts.length ? parts.join(", ") : "no tasks")}`;
	}
	if (kind === "delete") {
		const removed = removedEntries(safeValue(change, "removed"));
		if (!removed) return undefined;
		const subjects = removed.map((entry) => entry.subject);
		return withPreview(
			"deleted",
			removed.map((entry) => entry.id),
			subjects,
		);
	}
	return undefined;
}

export interface TodoGroupRenderContext {
	isError: boolean;
	isPartial: boolean;
	result?: AgentToolResult<unknown>;
}

/** Compact result-aware summary used only by collapsed todo tool groups. */
export function formatTodoGroupCall(
	args: TodoCallArgs | undefined,
	theme: Theme,
	context: TodoGroupRenderContext,
): string {
	if (context.isError) {
		let reason = "tool failed";
		try {
			for (const block of context.result?.content.slice(0, 8) ?? []) {
				if (block.type !== "text" || typeof block.text !== "string") continue;
				const text = block.text
					.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
					.replace(/\s+/g, " ")
					.trim();
				if (!text) continue;
				reason = text.length > GROUP_FAILURE_MAX_LENGTH ? `${text.slice(0, GROUP_FAILURE_MAX_LENGTH - 1)}…` : text;
				break;
			}
		} catch {
			// Tool results can come from historical or third-party sources.
		}
		return `${formatTodoCall(args, theme, false)} ${theme.fg("error", `failed: ${reason}`)}`;
	}
	if (!context.isPartial && context.result) {
		const summary = formatTodoGroupSuccess(args, theme, context.result);
		if (summary) return summary;
	}
	return formatTodoCall(args, theme, false);
}
