import { unlink, writeFile } from "node:fs/promises";
import { boundText } from "../../core/tasks/output.ts";
import type { TaskControl } from "../../core/tasks/types.ts";
import { writeOutputFile } from "../../utils/output-files.ts";
import type { AgentArtifacts } from "./artifacts.ts";
import { AGENT_REPORT_BYTES, type AgentToolDetails } from "./types.ts";

/** Reports can carry private data, so only the user may read the file. */
const REPORT_FILE_MODE = 0o600;

export interface FinalReport {
	/** The model-facing text, within AGENT_REPORT_BYTES. */
	text: string;
	/** The persistent file holding the complete report, when one was written. */
	reportPath?: string;
}

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

/** Write the complete report beside the session; an oversized one stays readable through `tasks read` and is never retired. */
async function persistReport(
	control: TaskControl<AgentToolDetails>,
	artifacts: AgentArtifacts,
	text: string,
): Promise<FinalReport | undefined> {
	try {
		await writeFile(artifacts.reportPath, text, { mode: REPORT_FILE_MODE });
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(text) <= AGENT_REPORT_BYTES) return { text, reportPath: artifacts.reportPath };
	try {
		// No cleanup: the report belongs to the session, not to Tasks retention.
		control.attachOutput(artifacts.reportPath);
	} catch {
		/* The notice below still names the file; only `tasks read` loses it. */
	}
	return { text: boundedReport(text, artifacts.reportPath), reportPath: artifacts.reportPath };
}

/**
 * The model-facing report. With session artifacts the complete report is always saved there and an
 * oversized one names that file. Without them, an oversized report keeps its beginning and names a
 * managed temporary Markdown file, which the task owns and cleans up.
 */
export async function finalReport(
	control: TaskControl<AgentToolDetails>,
	report: string,
	error: string | undefined,
	artifacts?: AgentArtifacts,
): Promise<FinalReport> {
	const text = !report ? (error ?? "No report returned.") : error ? `${report}\n\nError: ${error}` : report;
	const persisted = artifacts && (await persistReport(control, artifacts, text));
	if (persisted) return persisted;
	if (Buffer.byteLength(text) <= AGENT_REPORT_BYTES) return { text };
	let path: string | undefined;
	try {
		path = await writeOutputFile("pi-agent", ".md", text);
		const saved = path;
		control.attachOutput(saved, () => removeOutputFile(saved));
		return { text: boundedReport(text, saved) };
	} catch {
		if (path) await removeOutputFile(path).catch(() => {});
		return { text: boundedReport(text) };
	}
}
