/**
 * background — the `<background-task>` message sent to the model.
 *
 * Completion and stall are one message with one discriminant, not two parallel
 * builders: they share every element except the opening attributes, the
 * `<error>` a completion may carry, and the `<advice>` a stall always carries.
 *
 * The `details` this produces is persisted (see types.ts). `kind` deliberately
 * does NOT appear there — the stored shape keeps the `stalled?: true` flag it
 * has always had, so transcripts written by older builds keep rendering.
 */

import type { BgNotification } from "./registry.ts";
import { hasExitCode, runtimeLabel, runtimeMs } from "./task-view.ts";
import type { BgNotificationDetails } from "./types.ts";

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/**
 * Strip characters XML 1.0 forbids: C0 controls (except \t \n \r), lone
 * surrogates (U+D800–U+DFFF), and the non-characters U+FFFE/U+FFFF.
 * sanitizeBinaryOutput does not remove the latter two classes, so this filter
 * is the authority for every text field in the notification XML.
 */
function filterXmlCharacters(text: string): string {
	let result = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0d ||
			(code >= 0x20 && code <= 0xd7ff) ||
			(code >= 0xe000 && code <= 0xfffd) ||
			code >= 0x10000
		) {
			result += char;
		}
	}
	return result;
}

/**
 * filterXmlCharacters keeps \t \n \r and every other XML-legal codepoint, so
 * every field built with this is valid XML 1.0 after escaping.
 */
const xmlText = (text: string) => escapeXml(filterXmlCharacters(text));

const STALL_ADVICE =
	"The command appears blocked waiting for interactive input. Kill it (bg action kill) and " +
	"re-run with piped input (e.g. echo y | command) or a non-interactive flag if one exists (e.g. --yes). " +
	"The task keeps running until then.";

function renderOutputTail(notification: BgNotification): string[] {
	if (notification.tailError) {
		return [`<output-tail unavailable="${xmlText(notification.tailError)}"/>`];
	}
	const tail = notification.tail;
	const attrs = [
		`bytes="${tail?.sliceBytes ?? 0}"`,
		`totalBytes="${tail?.totalBytes ?? notification.task.outputBytes}"`,
		tail?.truncated ? 'truncated="true"' : "",
		tail?.startsMidLine ? 'startsMidLine="true"' : "",
	]
		.filter(Boolean)
		.join(" ");
	const text = tail?.text ?? "";
	const body = text.length > 0 ? xmlText(text) : "(no output)";
	return [`<output-tail ${attrs}>`, body.trimEnd(), "</output-tail>"];
}

export function buildNotificationContent(notification: BgNotification): string {
	const task = notification.task;
	// A stalled task is still running: it reports no terminal status, no exit
	// code, and no error — only that it appears to be waiting on input.
	const stalled = notification.kind === "stall";
	const attrs = [
		`id="${task.id}"`,
		stalled ? 'status="running" waiting-for-input="true"' : `status="${task.status}"`,
		!stalled && hasExitCode(task.exitCode) ? `exitCode="${task.exitCode}"` : "",
		`runtime="${runtimeLabel(task)}"`,
	]
		.filter(Boolean)
		.join(" ");

	const lines = [`<background-task ${attrs}>`, `<command>${xmlText(task.command)}</command>`];
	if (task.description) {
		lines.push(`<description>${xmlText(task.description)}</description>`);
	}
	lines.push(`<output-file>${xmlText(task.outputPath)}</output-file>`);
	if (!stalled && task.error) {
		lines.push(`<error>${xmlText(task.error)}</error>`);
	}
	lines.push(...renderOutputTail(notification));
	if (stalled) {
		lines.push(`<advice>${STALL_ADVICE}</advice>`);
	}
	lines.push("</background-task>");
	return lines.join("\n");
}

export function toNotificationDetails(notification: BgNotification): BgNotificationDetails {
	const task = notification.task;
	const stalled = notification.kind === "stall";
	return {
		taskId: task.id,
		command: task.command,
		description: task.description,
		status: stalled ? "running" : task.status,
		stalled: stalled ? true : undefined,
		exitCode: stalled ? undefined : task.exitCode,
		runtimeMs: runtimeMs(task),
		outputPath: task.outputPath,
		totalBytes: notification.tail?.totalBytes ?? task.outputBytes,
		tailText: notification.tail?.text ?? "",
		tailTruncated: notification.tail?.truncated ?? false,
		error: stalled ? undefined : task.error,
		tailError: notification.tailError,
	};
}
