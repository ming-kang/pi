import { unlink } from "node:fs/promises";
import { boundText } from "../../core/tasks/output.ts";
import type { TaskControl } from "../../core/tasks/types.ts";
import { writeOutputFile } from "../../utils/output-files.ts";
import { AGENT_REPORT_BYTES, type AgentToolDetails } from "./types.ts";

export function boundedReport(text: string, fullOutputPath?: string): string {
	if (Buffer.byteLength(text) <= AGENT_REPORT_BYTES) return text;
	const notice = fullOutputPath
		? `\n\n[Agent output truncated. Full output: ${fullOutputPath}]`
		: "\n\n[Agent output truncated. Full output unavailable.]";
	return boundText(text, AGENT_REPORT_BYTES - Buffer.byteLength(notice)) + notice;
}

async function removeOutputFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

/**
 * The model-facing report. An oversized report keeps its beginning and names a managed
 * Markdown file with the complete text, which the task owns and cleans up.
 */
export async function finalReport(
	control: TaskControl<AgentToolDetails>,
	report: string,
	error: string | undefined,
): Promise<string> {
	const text = !report ? (error ?? "No report returned.") : error ? `${report}\n\nError: ${error}` : report;
	if (Buffer.byteLength(text) <= AGENT_REPORT_BYTES) return text;
	let path: string | undefined;
	try {
		path = await writeOutputFile("pi-agent", ".md", text);
		const saved = path;
		control.attachOutput(saved, () => removeOutputFile(saved));
		return boundedReport(text, saved);
	} catch {
		if (path) await removeOutputFile(path).catch(() => {});
		return boundedReport(text);
	}
}
