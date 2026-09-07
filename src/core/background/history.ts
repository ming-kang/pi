import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	BACKGROUND_DETAILS_BYTES,
	BACKGROUND_RESULT_BYTES,
	BACKGROUND_TITLE_BYTES,
	boundedResult,
	boundText,
} from "./output.ts";
import { readBackgroundProjection } from "./presentation.ts";
import type { BackgroundTask } from "./types.ts";

export const BACKGROUND_HISTORY_VERSION = 2;

/** Read persisted data properties only; never invoke getters or custom serialization. */
function dataObject(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected plain object");
	return value as Record<string, unknown>;
}

function field(object: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor && !("value" in descriptor)) throw new Error("Unexpected accessor");
	return descriptor?.value;
}

function historyString(value: unknown, bytes: number, exact = false): string {
	if (typeof value !== "string") throw new Error("Expected string");
	if (exact && (!value || value.length > bytes || Buffer.byteLength(value) > bytes || value.includes("\0")))
		throw new Error("Invalid identity or path");
	return boundText(value, bytes);
}

/** Bound traversal before serialization, and omit unsupported/oversized details intact. */
function historyDetails(value: unknown): unknown {
	let budget = BACKGROUND_DETAILS_BYTES;
	function copy(value: unknown, depth: number): unknown {
		if (--budget < 0 || depth > 32) throw new Error("History details too large");
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			budget -= value.length;
			if (budget < 0) throw new Error("History details too large");
			return value;
		}
		if (Array.isArray(value)) {
			if (value.length > budget) throw new Error("History details too large");
			return Array.from({ length: value.length }, (_, index) => copy(field(value, String(index)), depth + 1));
		}
		const object = dataObject(value);
		const out: Record<string, unknown> = Object.create(null);
		for (const key in object) {
			if (!Object.hasOwn(object, key)) continue;
			budget -= key.length + 3;
			out[key] = copy(field(object, key), depth + 1);
		}
		return out;
	}
	try {
		return copy(value, 0);
	} catch {
		return undefined;
	}
}

export function parseBackgroundHistory(record: unknown): BackgroundTask | undefined {
	try {
		const envelope = dataObject(record);
		if (field(envelope, "version") !== BACKGROUND_HISTORY_VERSION) return undefined;
		const source = dataObject(field(envelope, "task"));
		const kind = field(source, "kind");
		const mode = field(source, "mode");
		const status = field(source, "status");
		if (kind !== "bash" && kind !== "subagent") return undefined;
		if (mode !== "foreground" && mode !== "background") return undefined;
		if (
			status !== "completed" &&
			status !== "partial" &&
			status !== "failed" &&
			status !== "cancelled" &&
			status !== "timeout"
		)
			return undefined;
		const startedAt = field(source, "startedAt");
		const endedAt = field(source, "endedAt");
		if (
			typeof startedAt !== "number" ||
			!Number.isSafeInteger(startedAt) ||
			startedAt < 0 ||
			typeof endedAt !== "number" ||
			!Number.isSafeInteger(endedAt) ||
			endedAt < startedAt
		)
			return undefined;
		const anchor = field(source, "anchorId");
		const task: BackgroundTask = {
			id: historyString(field(source, "id"), 512, true),
			kind,
			mode,
			status,
			startedAt,
			endedAt,
			title: historyString(field(source, "title"), BACKGROUND_TITLE_BYTES),
			toolCallId: historyString(field(source, "toolCallId"), 512, true),
			anchorId: anchor === null ? null : historyString(anchor, 8192, true),
		};
		if (!task.id.startsWith(`${kind}-`) || task.id.length <= kind.length + 1) return undefined;
		for (const [key, bytes] of [
			["command", 8192],
			["cwd", 4096],
			["error", 4096],
			["outputPath", 8192],
		] as const) {
			const value = field(source, key);
			if (value !== undefined) task[key] = historyString(value, bytes, key === "outputPath");
		}
		for (const key of ["commandTruncated", "resultTruncated"] as const) {
			const value = field(source, key);
			if (value !== undefined && typeof value !== "boolean") return undefined;
			task[key] = value;
		}
		if (task.command !== undefined && task.command !== field(source, "command")) task.commandTruncated = true;
		const projection = field(source, "projection");
		if (projection !== undefined) {
			task.projection = readBackgroundProjection(projection);
		}
		const result = field(source, "result");
		if (result !== undefined) {
			const object = dataObject(result);
			const blocks = field(object, "content");
			if (!Array.isArray(blocks)) return undefined;
			const content: AgentToolResult<unknown>["content"] = [];
			let remaining = BACKGROUND_RESULT_BYTES;
			for (let index = 0; index < blocks.length && remaining > 0; index++) {
				const block = dataObject(field(blocks, String(index)));
				const type = field(block, "type");
				if (type !== "text" && type !== "image") return undefined;
				const original = type === "text" ? field(block, "text") : undefined;
				const text =
					type === "text" ? historyString(original, remaining) : "[Image omitted from background history]";
				if (text !== original) task.resultTruncated = true;
				content.push({ type: "text", text });
				remaining -= Math.max(1, Buffer.byteLength(text));
			}
			if (content.length < blocks.length) task.resultTruncated = true;
			task.result = boundedResult({ content, details: historyDetails(field(object, "details")) });
		}
		return task;
	} catch {
		return undefined;
	}
}
