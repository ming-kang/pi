import type { CustomMessage } from "../messages.ts";
import { truncateHead } from "../tools/truncate.ts";
import { BACKGROUND_DETAILS_BYTES, BACKGROUND_RESULT_BYTES, BACKGROUND_TITLE_BYTES, boundText } from "./output.ts";
import type {
	BackgroundCompletionSnapshot,
	BackgroundProjection,
	BackgroundTask,
	BackgroundTerminalStatus,
	BackgroundText,
	BackgroundWorker,
	BackgroundWorkerReport,
} from "./types.ts";

const OUTPUT_BYTES = 40 * 1024;
const REPORT_BYTES = 4 * 1024;
const MAX_WORKERS = 8;
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

function text(value: unknown, bytes: number): BackgroundText {
	const source = object(value);
	const original = field(source, "text");
	const truncated = field(source, "truncated");
	if (typeof truncated !== "boolean") throw new Error("Expected truncation flag");
	const bounded = string(original, bytes);
	return { text: bounded, truncated: truncated || bounded !== original };
}

function workerReport(value: unknown): BackgroundWorkerReport {
	const source = object(value);
	return {
		id: string(field(source, "id"), 256),
		label: string(field(source, "label"), 512),
		profile: string(field(source, "profile"), 128),
		description: string(field(source, "description"), 512),
		status: string(field(source, "status"), 128),
		report: text(field(source, "report"), REPORT_BYTES),
		error: optionalString(source, "error", 1024),
	};
}

function workers<T>(value: unknown, read: (value: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new Error("Expected workers");
	return Array.from({ length: Math.min(value.length, MAX_WORKERS) }, (_, index) => read(field(value, String(index))));
}

/** Shared by live publication and history restoration; never imports an executor's private details. */
export function readBackgroundProjection(value: unknown): BackgroundProjection {
	const source = object(value);
	const projection: BackgroundProjection = { text: optionalString(source, "text", 16 * 1024) };
	const shell = field(source, "shell");
	if (shell !== undefined) {
		const fields = object(shell);
		projection.shell = {
			name: string(field(fields, "name"), 128),
			output: text(field(fields, "output"), OUTPUT_BYTES),
		};
	}
	const reports = field(source, "workers");
	if (reports !== undefined) {
		projection.workers = workers(reports, (value): BackgroundWorker => {
			const fields = object(value);
			return {
				...workerReport(value),
				prompt: string(field(fields, "prompt"), 4096),
				activity: string(field(fields, "activity"), 1024),
				model: optionalString(fields, "model", 256),
				usage: optionalString(fields, "usage", 256),
			};
		});
	}
	return projection;
}

function terminalStatus(value: unknown): BackgroundTerminalStatus {
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
export function readBackgroundCompletion(value: unknown): BackgroundCompletionSnapshot | undefined {
	try {
		const source = object(value);
		if (field(source, "version") !== 1) return undefined;
		const taskId = field(source, "taskId");
		const kind = field(source, "kind");
		if (kind !== "bash" && kind !== "subagent") return undefined;
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
			title: string(field(source, "title"), BACKGROUND_TITLE_BYTES),
			status: terminalStatus(field(source, "status")),
			startedAt,
			endedAt,
			error: optionalString(source, "error", 4096),
		};
		let snapshot: BackgroundCompletionSnapshot;
		if (kind === "bash") {
			const command = field(source, "command");
			const outputPath = field(source, "outputPath");
			// A clipped path would name a different file. Omit oversized paths intact.
			if (outputPath !== undefined && typeof outputPath !== "string") return undefined;
			snapshot = {
				...common,
				kind,
				shell: optionalString(source, "shell", 128),
				command: command === undefined ? undefined : text(command, 8192),
				cwd: optionalString(source, "cwd", 4096),
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
				workers: workers(field(source, "workers"), workerReport),
				output: output === undefined ? undefined : text(output, OUTPUT_BYTES),
			};
		}
		return Buffer.byteLength(JSON.stringify(snapshot)) <= BACKGROUND_DETAILS_BYTES ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

export function backgroundCompletionSnapshot(task: BackgroundTask): BackgroundCompletionSnapshot {
	const output: BackgroundText = {
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
	};
	const snapshot = readBackgroundCompletion(
		task.kind === "bash"
			? {
					...common,
					kind: "bash",
					shell: task.projection?.shell?.name,
					command:
						task.command === undefined
							? undefined
							: { text: task.command, truncated: task.commandTruncated ?? false },
					cwd: task.cwd,
					outputPath: task.outputPath,
					output: task.projection?.shell?.output ?? output,
				}
			: {
					...common,
					kind: "subagent",
					workers: task.projection?.workers ?? [],
					output: task.projection?.workers?.length ? undefined : output,
				},
	);
	if (!snapshot) throw new Error("Invalid background completion snapshot");
	return snapshot;
}

const singleLine = (value: string) => value.replace(/\s+/gu, " ").trim();
const OMISSION = "\n[Saved output truncated; use bg read for retained task details.]";

function modelText(value: BackgroundText, bytes: number, lines: number): string {
	const result = truncateHead(value.text, {
		maxBytes: Math.max(0, bytes - Buffer.byteLength(OMISSION)),
		maxLines: Math.max(1, lines - 1),
	});
	return result.content + (value.truncated || result.truncated ? OMISSION : "");
}

/** One bounded action hint per terminal outcome; completed work needs none. */
function nextStepLine(snapshot: BackgroundCompletionSnapshot): string {
	switch (snapshot.status) {
		case "cancelled":
			return "Next step: the task was cancelled — do not restart it unless the user asks.";
		case "timeout":
			return "Next step: the task hit its timeout; inspect the partial output above, then rerun with a longer timeout or in smaller pieces if still needed.";
		case "failed":
		case "partial": {
			if (snapshot.kind === "subagent") {
				const unfinished = snapshot.workers
					.filter((worker) => worker.status !== "completed")
					.map((worker) => singleLine(worker.description))
					.filter(Boolean);
				const names =
					unfinished.length > 3
						? `${unfinished.slice(0, 3).join(", ")}, +${unfinished.length - 3} more`
						: unfinished.join(", ");
				return names
					? `Next step: re-delegate the unfinished work in a fresh subagent call if still needed (${names}).`
					: "Next step: re-delegate the work in a fresh subagent call if still needed.";
			}
			return "Next step: diagnose from the output above before retrying; rerun only what is still needed.";
		}
		default:
			return "";
	}
}

/** The model and the card share facts; only the model receives this prose projection. */
function notificationText(snapshot: BackgroundCompletionSnapshot): string {
	const header = [
		`Background ${snapshot.kind} ${snapshot.taskId}: ${snapshot.status} — ${singleLine(snapshot.title)}`,
		snapshot.error ? `Error: ${singleLine(snapshot.error)}` : "",
	].filter(Boolean);
	if (snapshot.kind === "bash") {
		if (snapshot.command) header.push(`Command:\n${modelText(snapshot.command, 8192, 128)}`);
		if (snapshot.cwd) header.push(`cwd: ${singleLine(snapshot.cwd)}`);
		if (snapshot.outputPath) header.push(`Output: ${singleLine(snapshot.outputPath)}`);
	}
	const prefix = `${header.join("\n")}\n\n`;
	const guidance = nextStepLine(snapshot);
	const suffix = guidance ? `\n\n${guidance}` : "";
	const remaining = BACKGROUND_RESULT_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
	const lines = MODEL_LINES - prefix.split("\n").length - (guidance ? 3 : 0);
	if (snapshot.kind === "subagent" && snapshot.workers.length) {
		// Allocate before formatting, so one verbose report cannot erase later workers.
		const budget = Math.floor((remaining - 8 * snapshot.workers.length) / snapshot.workers.length);
		const lineBudget = Math.floor((lines - 4 * snapshot.workers.length) / snapshot.workers.length);
		return (
			prefix +
			snapshot.workers
				.map((worker, index) => {
					const heading = `### ${index + 1}. ${singleLine(worker.description)} (${singleLine(worker.profile)}) — ${singleLine(worker.status)}\n\n`;
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

export function backgroundCompletionMessage(task: BackgroundTask): CustomMessage<BackgroundCompletionSnapshot> {
	const details = backgroundCompletionSnapshot(task);
	return {
		role: "custom",
		customType: "background-completion",
		display: true,
		content: notificationText(details),
		details,
		timestamp: Date.now(),
	};
}
