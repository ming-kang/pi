/**
 * The one reader for persisted task snapshots: session `task-record` entries and
 * `task-completion` message details share this format and these bounds.
 */
import {
	boundText,
	TASK_ERROR_BYTES,
	TASK_FACT_BYTES,
	TASK_FACTS,
	TASK_INPUT_BYTES,
	TASK_LABEL_BYTES,
	TASK_PATH_BYTES,
	TASK_RESULT_BYTES,
	TASK_TITLE_BYTES,
} from "./output.ts";
import {
	isTaskTerminal,
	TASK_KIND_PATTERN,
	type TaskFact,
	type TaskInput,
	type TaskSnapshot,
	type TaskStatus,
	type TaskText,
} from "./types.ts";

export const TASK_RECORD_TYPE = "task-record";
/** Shared by `task-record` entries and `task-completion` details. */
export const TASK_SNAPSHOT_VERSION = 3;

/** Read persisted data properties only; never invoke getters or custom serialization. */
export function plainObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected plain object");
	return value as Record<string, unknown>;
}

export function field(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor && !("value" in descriptor)) throw new Error("Unexpected accessor");
	return descriptor?.value;
}

function text(value: unknown, bytes: number): string {
	if (typeof value !== "string") throw new Error("Expected string");
	return boundText(value, bytes);
}

/** Identities and paths are never clipped: a shortened value would name something else. */
function exact(value: unknown, bytes: number): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value) > bytes || value.includes("\0"))
		throw new Error("Invalid identity or path");
	return value;
}

function optional<T>(source: object, key: string, read: (value: unknown) => T): T | undefined {
	const value = field(source, key);
	return value === undefined ? undefined : read(value);
}

function taskText(value: unknown, bytes: number): TaskText {
	const source = plainObject(value);
	const original = field(source, "text");
	const truncated = field(source, "truncated");
	if (typeof truncated !== "boolean") throw new Error("Expected truncation flag");
	const bounded = text(original, bytes);
	return { text: bounded, truncated: truncated || bounded !== original };
}

function taskInput(value: unknown): TaskInput {
	const source = plainObject(value);
	const language = optional(source, "language", (item) => text(item, 64));
	return {
		label: text(field(source, "label"), TASK_LABEL_BYTES),
		...taskText(source, TASK_INPUT_BYTES),
		...(language ? { language } : {}),
	};
}

function taskFacts(value: unknown): TaskFact[] {
	if (!Array.isArray(value)) throw new Error("Expected facts");
	return value.slice(0, TASK_FACTS).map((row): TaskFact => {
		if (!Array.isArray(row) || row.length !== 2) throw new Error("Expected fact");
		return [text(row[0], TASK_LABEL_BYTES), text(row[1], TASK_FACT_BYTES)];
	});
}

function timestamp(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Expected time");
	return value;
}

/** A bounded terminal snapshot, or undefined for any other shape or version. */
export function readPersistedTask(value: unknown): TaskSnapshot | undefined {
	try {
		const source = plainObject(value);
		const kind = field(source, "kind");
		const mode = field(source, "mode");
		const status = field(source, "status") as TaskStatus;
		const output = field(source, "output");
		if (typeof kind !== "string" || !TASK_KIND_PATTERN.test(kind)) return undefined;
		if (mode !== "foreground" && mode !== "background") return undefined;
		if (output !== "log" && output !== "report") return undefined;
		if (typeof status !== "string" || !isTaskTerminal(status)) return undefined;
		const startedAt = timestamp(field(source, "startedAt"));
		const endedAt = timestamp(field(source, "endedAt"));
		if (endedAt < startedAt) return undefined;
		const id = exact(field(source, "id"), 512);
		if (!id.startsWith(`${kind}-`) || id.length <= kind.length + 1) return undefined;
		const anchor = field(source, "anchorId");
		const task: TaskSnapshot = {
			id,
			kind,
			label: text(field(source, "label"), TASK_LABEL_BYTES),
			title: text(field(source, "title"), TASK_TITLE_BYTES),
			output,
			toolCallId: exact(field(source, "toolCallId"), 512),
			anchorId: anchor === null ? null : exact(anchor, 8192),
			mode,
			status,
			startedAt,
			endedAt,
		};
		const input = optional(source, "input", taskInput);
		const facts = optional(source, "facts", taskFacts);
		const outputPath = optional(source, "outputPath", (item) => exact(item, TASK_PATH_BYTES));
		const result = optional(source, "result", (item) => taskText(item, TASK_RESULT_BYTES));
		const display = optional(source, "display", (item) => taskText(item, TASK_RESULT_BYTES));
		const error = optional(source, "error", (item) => text(item, TASK_ERROR_BYTES));
		return {
			...task,
			...(input ? { input } : {}),
			...(facts ? { facts } : {}),
			...(outputPath ? { outputPath } : {}),
			...(result ? { result } : {}),
			...(display ? { display } : {}),
			...(error !== undefined ? { error } : {}),
		};
	} catch {
		return undefined;
	}
}

/** The task saved by a `task-record` entry or `task-completion` details. */
export function readVersionedTask(value: unknown): TaskSnapshot | undefined {
	try {
		const source = plainObject(value);
		return field(source, "version") === TASK_SNAPSHOT_VERSION ? readPersistedTask(field(source, "task")) : undefined;
	} catch {
		return undefined;
	}
}
