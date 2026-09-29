/**
 * todo/view.ts — v3 presentation: the one-line above-editor widget renderer,
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

/** One-line widget: `Todos 2/6 · [>] #4 s  [ ] #5 s  +N more`; only hidden open tasks count in the overflow. */
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
	const shown: Array<{ item: TodoItem; subject: string }> = [];
	let overflow = "";

	// Count only open tasks not shown by the trial segments.
	const bestOverflow = (trial: Array<{ item: TodoItem; subject: string }>): string | undefined => {
		const remaining = candidates.length - trial.length;
		const segments = trial.map((entry) => widgetSegment(entry.item, entry.subject, theme));
		if (remaining <= 0) return visibleWidth(widgetLine(header, segments, "")) <= safeWidth ? "" : undefined;
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
		const remaining = candidates.length - shown.length - 1;
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

// --- Model-facing result text ------------------------------------------------

/** `#1–#3` for a consecutive run, `#1, #2` otherwise. */
function formatIdRange(ids: number[]): string {
	const consecutive = ids.length > 1 && ids.every((id, index) => id === ids[0] + index);
	return consecutive ? `#${ids[0]}–#${ids[ids.length - 1]}` : ids.map((id) => `#${id}`).join(", ");
}

/**
 * One-line change summary for a completed call, e.g.
 * `Created 1 task: #7: Wire parser (in_progress); Updated #1 (pending -> completed): S; demoted #5 to pending; auto-removed completed #1–#3 to stay within 20`.
 * A call that changed nothing (including `{}`) returns the full list.
 */
export function formatTodoContent(change: TodoChange, state: TodoState): string {
	const parts: string[] = [];
	if (change.created.length > 0) {
		const labels = change.created.map((id) => {
			const item = state.items.find((entry) => entry.id === id);
			if (!item) return `#${id}`;
			const suffix = item.status === "pending" ? "" : ` (${item.status})`;
			return `#${id}: ${item.subject}${suffix}`;
		});
		const noun = change.created.length === 1 ? "task" : "tasks";
		parts.push(`Created ${change.created.length} ${noun}: ${labels.join("; ")}`);
	}
	for (const entry of change.updated) {
		const item = state.items.find((candidate) => candidate.id === entry.id);
		const subject = item ? `: ${item.subject}` : "";
		const transition = entry.from === entry.to ? "" : ` (${entry.from} -> ${entry.to})`;
		parts.push(`Updated #${entry.id}${transition}${subject}`);
	}
	if (change.demotedId !== undefined) parts.push(`demoted #${change.demotedId} to pending`);
	if (change.deleted.length > 0) {
		const noun = change.deleted.length === 1 ? "task" : "tasks";
		const labels = change.deleted.map((entry) => `#${entry.id}: ${entry.subject}`);
		parts.push(`Deleted ${change.deleted.length} ${noun}: ${labels.join("; ")}`);
	}
	for (const id of change.absent) parts.push(`#${id} already absent`);
	if (change.evicted.length > 0) {
		const ids = change.evicted.map((entry) => entry.id);
		parts.push(`auto-removed completed ${formatIdRange(ids)} to stay within ${TODO_MAX_ITEMS}`);
	}
	if (parts.length === 0) return formatTodoList(state);
	return parts.join("; ");
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
const SUMMARY_FAILURE_MAX_LENGTH = 120;

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

/** Id lists: invalid entries drop (rendering never rejects the whole call). */
function readIds(value: unknown): number[] | undefined {
	const array = readArray(value);
	if (!array) return undefined;
	const ids: number[] = [];
	for (const entry of array.values) {
		const id = safeId(entry);
		if (id !== undefined) ids.push(id);
	}
	return ids;
}

interface CreateCallItem {
	subject: string;
	description: string;
	status?: TodoStatus;
}

/** Create args: sparse or invalid entries drop; the batch caps at the maximum. */
function batchCreateItems(value: unknown): CreateCallItem[] {
	const result: CreateCallItem[] = [];
	for (const raw of readArray(value)?.values ?? []) {
		const item = safeRecord(raw);
		if (!item) continue;
		const entry: CreateCallItem = {
			subject: safeSubject(safeValue(item, "subject")),
			description: safeDescription(safeValue(item, "description")),
		};
		const status = safeStatus(safeValue(item, "status"));
		if (status) entry.status = status;
		result.push(entry);
	}
	return result;
}

interface UpdateCallItem {
	id?: number;
	subject: string;
	description: string;
	status?: TodoStatus;
}

/** Update args: sparse or invalid entries drop; the batch caps at the maximum. */
function batchUpdateItems(value: unknown): UpdateCallItem[] {
	const result: UpdateCallItem[] = [];
	for (const raw of readArray(value)?.values ?? []) {
		const item = safeRecord(raw);
		if (!item) continue;
		const entry: UpdateCallItem = {
			subject: safeSubject(safeValue(item, "subject")),
			description: safeDescription(safeValue(item, "description")),
		};
		const id = safeId(safeValue(item, "id"));
		if (id !== undefined) entry.id = id;
		const status = safeStatus(safeValue(item, "status"));
		if (status) entry.status = status;
		result.push(entry);
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

/** v3 details guard shared by the call and group renderers. */
function todoDetails(value: unknown): { change: Record<string, unknown>; state: Record<string, unknown> } | undefined {
	const details = safeRecord(value);
	if (!details || safeValue(details, "schemaVersion") !== TODO_DETAILS_SCHEMA_VERSION) return undefined;
	const change = safeRecord(safeValue(details, "change"));
	const state = safeRecord(safeValue(details, "state"));
	if (!change || !state) return undefined;
	return { change, state };
}

/** Result ids for an expanded create, only when they match the shown items. */
function createResultIds(result: AgentToolResult<unknown> | undefined, count: number): number[] | undefined {
	const details = todoDetails(result?.details);
	if (!details) return undefined;
	const ids = readIds(safeValue(details.change, "created"));
	return ids && ids.length === count && count > 0 ? ids : undefined;
}

/** Removed entries from a settled result, for the expanded delete detail lines. */
function deleteResultRemoved(result: AgentToolResult<unknown> | undefined): Array<{ id: number; subject: string }> {
	const details = todoDetails(result?.details);
	if (!details) return [];
	return idSubjectEntries(safeValue(details.change, "deleted"));
}

/** Absent ids from a settled delete, for the expanded delete detail lines. */
function deleteResultAbsent(result: AgentToolResult<unknown> | undefined): number[] {
	const details = todoDetails(result?.details);
	if (!details) return [];
	return readIds(safeValue(details.change, "absent")) ?? [];
}

/** Headline plus the parameters the result never echoes as detail lines. */
function formatCallParts(
	args: TodoCallArgs | undefined,
	theme: Theme,
	result?: AgentToolResult<unknown>,
): { headline: string; details: string[] } {
	const details: string[] = [];
	const segments: string[] = [];
	const pushSegment = (verb: string, body: string): void => {
		const title = segments.length === 0 ? `todo ${verb}` : verb;
		segments.push(
			body ? `${theme.fg("toolTitle", theme.bold(title))} ${body}` : theme.fg("toolTitle", theme.bold(title)),
		);
	};

	const hasCreate = args?.create !== undefined;
	const hasUpdate = args?.update !== undefined;
	const hasDelete = args?.delete !== undefined;

	if (hasCreate) {
		const items = batchCreateItems(args?.create);
		const rawCount = readArray(args?.create)?.length;
		// An empty array is strict-mode filler: the call lists the tasks, so the
		// group earns no segment of its own.
		if (rawCount !== 0) {
			const body: string[] = [];
			if (rawCount !== undefined) {
				const count = Math.min(rawCount, CALL_ITEMS_MAX);
				body.push(theme.fg("dim", `${count} ${count === 1 ? "task" : "tasks"}`));
				const preview = formatSubjectPreview(
					items.map((item) => item.subject),
					count,
				);
				if (preview) body.push(theme.fg("dim", "·"), theme.fg("text", preview));
			}
			pushSegment("create", body.join(" "));
		}
		const ids = createResultIds(result, items.length);
		for (const [index, item] of items.entries()) {
			const marker = ids ? theme.fg("accent", `#${ids[index]}`) : theme.fg("accent", `${index + 1}.`);
			const status =
				item.status && item.status !== "pending"
					? ` ${theme.fg(STATUS_COLOR[item.status], `(${item.status})`)}`
					: "";
			details.push(item.subject ? `${marker} ${theme.fg("text", item.subject)}${status}` : marker);
			if (item.description) details.push(`    ${theme.fg("dim", descriptionPreview(item.description))}`);
		}
	}

	if (hasUpdate) {
		const items = batchUpdateItems(args?.update);
		const rawCount = readArray(args?.update)?.length;
		if (rawCount !== 0) {
			const entries: string[] = [];
			for (const item of items) {
				const parts: string[] = [];
				if (item.id !== undefined) parts.push(theme.fg("accent", `#${item.id}`));
				if (item.status) parts.push(theme.fg(STATUS_COLOR[item.status], item.status));
				if (item.subject)
					parts.push(theme.fg("text", truncateToWidth(item.subject, CALL_SUBJECT_PREVIEW_WIDTH, "…")));
				if (parts.length > 0) entries.push(parts.join(" "));
			}
			pushSegment("update", entries.join(theme.fg("dim", ", ")));
		}
		for (const item of items) {
			if (item.description) details.push(`    ${theme.fg("dim", descriptionPreview(item.description))}`);
		}
	}

	if (hasDelete) {
		const rawCount = readArray(args?.delete)?.length;
		if (rawCount !== 0) {
			const ids = readIds(args?.delete) ?? [];
			pushSegment("delete", ids.length > 0 ? theme.fg("accent", ids.map((id) => `#${id}`).join(", ")) : "");
		}
		// The headline already carries the ids, so details only earn their lines
		// once the result names what was actually removed or already absent.
		for (const entry of deleteResultRemoved(result)) {
			details.push(`${theme.fg("accent", `#${entry.id}`)} ${theme.fg("text", entry.subject)}`);
		}
		for (const id of deleteResultAbsent(result)) {
			details.push(theme.fg("dim", `#${id} already absent`));
		}
	}

	if (segments.length === 0) {
		// No group fields at all: the call lists the tasks.
		segments.push(theme.fg("toolTitle", theme.bold("todo list")));
	}

	return { headline: segments.join(theme.fg("dim", " ; ")), details };
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

/** Id -> item index plus status counts over the v3 snapshot (one defensive walk). */
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

/** Id+subject entries (deleted, evicted): invalid entries drop. */
function idSubjectEntries(value: unknown): Array<{ id: number; subject: string }> {
	const entries: Array<{ id: number; subject: string }> = [];
	for (const raw of readArray(value)?.values ?? []) {
		const item = safeRecord(raw);
		const id = safeId(safeValue(item, "id"));
		const subject = safeSubject(safeValue(item, "subject"));
		if (id === undefined || !subject) continue;
		entries.push({ id, subject });
	}
	return entries;
}

/** Updated entries: {id, from, to} records, invalid entries drop. */
function updatedEntries(value: unknown): Array<{ id: number; from?: TodoStatus; to?: TodoStatus }> {
	const entries: Array<{ id: number; from?: TodoStatus; to?: TodoStatus }> = [];
	for (const raw of readArray(value)?.values ?? []) {
		const item = safeRecord(raw);
		const id = safeId(safeValue(item, "id"));
		if (id === undefined) continue;
		const entry: { id: number; from?: TodoStatus; to?: TodoStatus } = { id };
		const from = safeStatus(safeValue(item, "from"));
		if (from) entry.from = from;
		const to = safeStatus(safeValue(item, "to"));
		if (to) entry.to = to;
		entries.push(entry);
	}
	return entries;
}

function formatTodoSuccessSummary(
	args: TodoCallArgs | undefined,
	theme: Theme,
	result: AgentToolResult<unknown>,
): string | undefined {
	const parsed = todoDetails(result.details);
	if (!parsed) return undefined;
	const { change, state } = parsed;
	const index = stateIndex(state);
	const segments: string[] = [];
	const pushVerb = (word: string, body: string): void => {
		const title = segments.length === 0 ? `todo ${word}` : word;
		segments.push(body ? `${theme.fg("toolTitle", title)} ${body}` : theme.fg("toolTitle", title));
	};
	const withPreview = (word: string, ids: number[], subjects: string[]): void => {
		const text = formatSubjectPreview(subjects, subjects.length);
		const base = theme.fg("accent", formatIdRange(ids));
		pushVerb(word, text ? `${base}${theme.fg("dim", " · ")}${theme.fg("text", text)}` : base);
	};

	const created = readIds(safeValue(change, "created")) ?? [];
	if (created.length > 0 && index) {
		withPreview(
			"created",
			created,
			created.map((id) => stateSubject(index.byId, id)),
		);
	}
	for (const entry of updatedEntries(safeValue(change, "updated"))) {
		const parts = [theme.fg("accent", `#${entry.id}`)];
		if (entry.to) parts.push(theme.fg(STATUS_COLOR[entry.to], entry.to));
		const subject = index ? stateSubject(index.byId, entry.id) : "";
		if (subject) parts.push(theme.fg("text", truncateToWidth(subject, CALL_SUBJECT_PREVIEW_WIDTH, "…")));
		pushVerb("updated", parts.join(" "));
	}
	const demotedId = safeId(safeValue(change, "demotedId"));
	if (demotedId !== undefined) segments.push(theme.fg("dim", `demoted #${demotedId}`));
	const deleted = idSubjectEntries(safeValue(change, "deleted"));
	if (deleted.length > 0) {
		withPreview(
			"deleted",
			deleted.map((entry) => entry.id),
			deleted.map((entry) => entry.subject),
		);
	}
	for (const id of readIds(safeValue(change, "absent")) ?? []) {
		segments.push(theme.fg("dim", `#${id} already absent`));
	}
	const evicted = idSubjectEntries(safeValue(change, "evicted"));
	if (evicted.length > 0) {
		segments.push(theme.fg("dim", `auto-removed ${evicted.map((entry) => `#${entry.id}`).join(", ")}`));
	}

	if (segments.length === 0) {
		// Empty change: the call listed the tasks.
		if (!index) return undefined;
		const parts: string[] = [];
		if (index.counts.inProgress > 0) parts.push(`${index.counts.inProgress} in progress`);
		if (index.counts.pending > 0) parts.push(`${index.counts.pending} pending`);
		if (index.counts.completed > 0) parts.push(`${index.counts.completed} completed`);
		return `${theme.fg("toolTitle", "todo list")}: ${theme.fg("dim", parts.length ? parts.join(", ") : "no tasks")}`;
	}
	// The update segment can still pick up the requested subject when the state
	// no longer holds it (e.g. the task was deleted by a hostile snapshot).
	void args;
	return segments.join(theme.fg("dim", " ; "));
}

export interface TodoSummaryContext {
	isError: boolean;
	isPartial: boolean;
	result?: AgentToolResult<unknown>;
}

/** Compact result-aware one-line summary of a collapsed todo row. */
export function formatTodoSummary(args: TodoCallArgs | undefined, theme: Theme, context: TodoSummaryContext): string {
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
				reason =
					text.length > SUMMARY_FAILURE_MAX_LENGTH ? `${text.slice(0, SUMMARY_FAILURE_MAX_LENGTH - 1)}…` : text;
				break;
			}
		} catch {
			// Tool results can come from historical or third-party sources.
		}
		return `${formatTodoCall(args, theme, false)} ${theme.fg("error", `failed: ${reason}`)}`;
	}
	if (!context.isPartial && context.result) {
		const summary = formatTodoSuccessSummary(args, theme, context.result);
		if (summary) return summary;
	}
	return formatTodoCall(args, theme, false);
}
