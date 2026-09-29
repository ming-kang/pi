import type { CustomMessage } from "../messages.ts";
import { truncateHead } from "../tools/truncate.ts";
import { boundText, TASK_DETAILS_BYTES, TASK_RESULT_BYTES, TASK_TITLE_BYTES } from "./output.ts";
import type {
	TaskCompletionSnapshot,
	TaskItem,
	TaskItemReport,
	TaskProjection,
	TaskSnapshot,
	TaskTerminalStatus,
	TaskText,
} from "./types.ts";

const OUTPUT_BYTES = 40 * 1024;
const REPORT_BYTES = 4 * 1024;
const MAX_ITEMS = 8;
const MODEL_LINES = 2000;

/** Read data properties only, including at the persisted-message boundary. */
function object(value: unknown): object {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected snapshot object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Expected plain snapshot");
	return value;
}

function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor && !("value" in descriptor)) throw new Error("Unexpected snapshot accessor");
	return descriptor?.value;
}

/** Bound escaped JSON as well as UTF-8, without serializing an unbounded source. */
function string(value: unknown, bytes: number): string {
	if (typeof value !== "string") throw new Error("Expected snapshot text");
	const prefix = boundText(value, bytes - 2);
	if (Buffer.byteLength(JSON.stringify(prefix)) <= bytes) return prefix;
	let low = 0;
	let high = Buffer.byteLength(prefix);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(JSON.stringify(boundText(prefix, middle))) <= bytes) low = middle;
		else high = middle - 1;
	}
	return boundText(prefix, low);
}

function optionalString(source: object, key: string, bytes: number): string | undefined {
	const value = field(source, key);
	return value === undefined ? undefined : string(value, bytes);
}

function text(value: unknown, bytes: number): TaskText {
	const source = object(value);
	const original = field(source, "text");
	const truncated = field(source, "truncated");
	if (typeof truncated !== "boolean") throw new Error("Expected truncation flag");
	const bounded = string(original, bytes);
	return { text: bounded, truncated: truncated || bounded !== original };
}

function itemReport(value: unknown): TaskItemReport {
	const source = object(value);
	return {
		id: string(field(source, "id"), 256),
		label: string(field(source, "label"), 512),
		category: string(field(source, "category"), 128),
		description: string(field(source, "description"), 512),
		status: string(field(source, "status"), 128),
		report: text(field(source, "report"), REPORT_BYTES),
		error: optionalString(source, "error", 1024),
	};
}

function items<T>(value: unknown, read: (value: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new Error("Expected items");
	return Array.from({ length: Math.min(value.length, MAX_ITEMS) }, (_, index) => read(field(value, String(index))));
}

/** Shared by live publication and history restoration; never imports an executor's private details. */
export function readTaskProjection(value: unknown): TaskProjection {
	const source = object(value);
	const projection: TaskProjection = {
		nextStep: optionalString(source, "nextStep", 2048),
		text: optionalString(source, "text", 16 * 1024),
	};
	const shell = field(source, "shell");
	if (shell !== undefined) {
		const fields = object(shell);
		projection.shell = {
			name: string(field(fields, "name"), 128),
			output: text(field(fields, "output"), OUTPUT_BYTES),
		};
	}
	const reports = field(source, "items");
	if (reports !== undefined) {
		projection.items = items(reports, (value): TaskItem => {
			const fields = object(value);
			return {
				...itemReport(value),
				input: string(field(fields, "input"), 4096),
				activity: string(field(fields, "activity"), 1024),
				context: optionalString(fields, "context", 256),
				usage: optionalString(fields, "usage", 256),
			};
		});
	}
	return projection;
}

function terminalStatus(value: unknown): TaskTerminalStatus {
	if (
		value === "completed" ||
		value === "partial" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "timeout"
	)
		return value;
	throw new Error("Expected terminal status");
}

/** Only this format is understood. Invalid/older details receive the renderer's bounded plain-text fallback. */
export function readTaskCompletion(value: unknown): TaskCompletionSnapshot | undefined {
	try {
		const source = object(value);
		if (field(source, "version") !== 1) return undefined;
		const taskId = field(source, "taskId");
		const kind = field(source, "kind");
		if (typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) return undefined;
		const format = field(source, "format");
		if (format !== "log" && format !== "report") return undefined;
		if (
			typeof taskId !== "string" ||
			!taskId.startsWith(`${kind}-`) ||
			taskId.length <= kind.length + 1 ||
			taskId.length > 512 ||
			Buffer.byteLength(taskId) > 512 ||
			taskId.includes("\0")
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
		const common = {
			version: 1 as const,
			taskId,
			title: string(field(source, "title"), TASK_TITLE_BYTES),
			status: terminalStatus(field(source, "status")),
			startedAt,
			endedAt,
			error: optionalString(source, "error", 4096),
			nextStep: optionalString(source, "nextStep", 2048),
		};
		let snapshot: TaskCompletionSnapshot;
		if (format === "log") {
			const command = field(source, "command");
			const outputPath = field(source, "outputPath");
			const exitCode = field(source, "exitCode");
			if (
				exitCode !== undefined &&
				exitCode !== null &&
				(typeof exitCode !== "number" || !Number.isSafeInteger(exitCode))
			)
				return undefined;
			// A clipped path would name a different file. Omit oversized paths intact.
			if (outputPath !== undefined && typeof outputPath !== "string") return undefined;
			snapshot = {
				...common,
				kind,
				format,
				shell: optionalString(source, "shell", 128),
				command: command === undefined ? undefined : text(command, 8192),
				cwd: optionalString(source, "cwd", 4096),
				...(exitCode !== undefined ? { exitCode } : {}),
				outputPath:
					outputPath &&
					!outputPath.includes("\0") &&
					outputPath.length <= 8192 &&
					Buffer.byteLength(JSON.stringify(outputPath)) <= 8192
						? outputPath
						: undefined,
				output: text(field(source, "output"), OUTPUT_BYTES),
			};
		} else {
			const output = field(source, "output");
			snapshot = {
				...common,
				kind,
				format,
				items: items(field(source, "items"), itemReport),
				output: output === undefined ? undefined : text(output, OUTPUT_BYTES),
			};
		}
		return Buffer.byteLength(JSON.stringify(snapshot)) <= TASK_DETAILS_BYTES ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

export function taskCompletionSnapshot(task: TaskSnapshot): TaskCompletionSnapshot {
	const output: TaskText = {
		text:
			task.result?.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n") ||
			task.projection?.text ||
			"",
		truncated: task.resultTruncated ?? false,
	};
	const common = {
		version: 1,
		taskId: task.id,
		title: task.title,
		status: task.status,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		error: task.error,
		nextStep: task.projection?.nextStep,
	};
	const snapshot = readTaskCompletion(
		task.format === "log"
			? {
					...common,
					kind: task.kind,
					format: "log",
					shell: task.projection?.shell?.name,
					command:
						task.command === undefined
							? undefined
							: { text: task.command, truncated: task.commandTruncated ?? false },
					cwd: task.cwd,
					outputPath: task.outputPath,
					...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
					output: task.projection?.shell?.output ?? output,
				}
			: {
					...common,
					kind: task.kind,
					format: "report",
					items: task.projection?.items ?? [],
					output: task.projection?.items?.length ? undefined : output,
				},
	);
	if (!snapshot) throw new Error("Invalid background completion snapshot");
	return snapshot;
}

const singleLine = (value: string) => value.replace(/\s+/gu, " ").trim();
const OMISSION = "\n[Saved output truncated; use tasks read for retained task details.]";

function modelText(value: TaskText, bytes: number, lines: number): string {
	const result = truncateHead(value.text, {
		maxBytes: Math.max(0, bytes - Buffer.byteLength(OMISSION)),
		maxLines: Math.max(1, lines - 1),
	});
	return result.content + (value.truncated || result.truncated ? OMISSION : "");
}

/** One bounded action hint per terminal outcome; completed work needs none. */
function nextStepLine(snapshot: TaskCompletionSnapshot): string {
	switch (snapshot.status) {
		case "cancelled":
			return "Next step: the task was cancelled — do not restart it unless the user asks.";
		case "timeout":
			return "Next step: the task hit its timeout; inspect the partial output above, then rerun with a longer timeout or in smaller pieces if still needed.";
		case "failed":
		case "partial": {
			if (snapshot.nextStep) return snapshot.nextStep;
			return "Next step: diagnose from the output above before retrying; rerun only what is still needed.";
		}
		default:
			return "";
	}
}

/** The context and the card share facts; only the context receives this prose projection. */
function notificationText(snapshot: TaskCompletionSnapshot): string {
	const header = [
		`Background ${snapshot.kind} ${snapshot.taskId}: ${snapshot.status} — ${singleLine(snapshot.title)}`,
		snapshot.error ? `Error: ${singleLine(snapshot.error)}` : "",
	].filter(Boolean);
	if (snapshot.format === "log") {
		if (snapshot.command) header.push(`Command:\n${modelText(snapshot.command, 8192, 128)}`);
		if (snapshot.cwd) header.push(`cwd: ${singleLine(snapshot.cwd)}`);
		if (snapshot.outputPath) header.push(`Output: ${singleLine(snapshot.outputPath)}`);
	}
	const prefix = `${header.join("\n")}\n\n`;
	const guidance = nextStepLine(snapshot);
	const suffix = guidance ? `\n\n${guidance}` : "";
	const remaining = TASK_RESULT_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
	const lines = MODEL_LINES - prefix.split("\n").length - (guidance ? 3 : 0);
	if (snapshot.format === "report" && snapshot.items.length) {
		// Allocate before formatting, so one verbose report cannot erase later items.
		const budget = Math.floor((remaining - 8 * snapshot.items.length) / snapshot.items.length);
		const lineBudget = Math.floor((lines - 4 * snapshot.items.length) / snapshot.items.length);
		return (
			prefix +
			snapshot.items
				.map((worker, index) => {
					const heading = `### ${index + 1}. ${singleLine(worker.description)} (${singleLine(worker.category)}) — ${singleLine(worker.status)}\n\n`;
					const reason = worker.error ? `Error: ${singleLine(worker.error)}\n\n` : "";
					const body = worker.report.text
						? worker.report
						: { text: "No report returned.", truncated: worker.report.truncated };
					return heading + reason + modelText(body, budget - Buffer.byteLength(heading + reason), lineBudget);
				})
				.join("\n\n---\n\n") +
			suffix
		);
	}
	return (
		prefix + modelText(snapshot.output ?? { text: "No text result.", truncated: false }, remaining, lines) + suffix
	);
}

export function taskCompletionMessage(task: TaskSnapshot): CustomMessage<TaskCompletionSnapshot> {
	const details = taskCompletionSnapshot(task);
	return {
		role: "custom",
		customType: "task-completion",
		display: true,
		content: notificationText(details),
		details,
		timestamp: Date.now(),
	};
}
