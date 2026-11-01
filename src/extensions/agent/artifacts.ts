import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { clipText } from "./activity.ts";

/** Files one Agent task keeps beside the session that launched it, so they outlive Tasks retention and restore. */
export interface AgentArtifacts {
	dir: string;
	reportPath: string;
	transcriptPath: string;
	/** The launching session file, recorded as the transcript's parent. */
	parentSession?: string;
}

/** Room reserved for a trailing ` +N more`. */
const MORE_RESERVE_BYTES = 16;

/** `<session artifacts>/agents/<taskId>/`, created on demand; undefined when the session is not persisted or the directory is unavailable. */
export async function prepareArtifacts(
	sessionArtifactDir: string | undefined,
	taskId: string,
	parentSession: string | undefined,
): Promise<AgentArtifacts | undefined> {
	if (!sessionArtifactDir) return undefined;
	const dir = join(sessionArtifactDir, "agents", taskId);
	try {
		await mkdir(dir, { recursive: true });
	} catch {
		return undefined;
	}
	return { dir, reportPath: join(dir, "report.md"), transcriptPath: join(dir, "transcript.jsonl"), parentSession };
}

/** The transcript path once the child session has written it; a run that failed before its first message has none. */
export function savedTranscript(artifacts: AgentArtifacts | undefined): string | undefined {
	return artifacts && existsSync(artifacts.transcriptPath) ? artifacts.transcriptPath : undefined;
}

/** Items joined by commas within `bytes`, ending in `+N more` when some do not fit. */
export function fitList(items: readonly string[], bytes: number): string {
	const full = items.join(", ");
	if (Buffer.byteLength(full) <= bytes) return full;
	let shown = 0;
	let used = 0;
	for (const item of items) {
		const next = used + Buffer.byteLength(item) + (shown ? 2 : 0);
		if (next > bytes - MORE_RESERVE_BYTES) break;
		used = next;
		shown++;
	}
	if (items.length === 1) return clipText(full, bytes);
	if (shown === 0) return `${clipText(items[0] ?? "", bytes - MORE_RESERVE_BYTES)} +${items.length - 1} more`;
	return `${items.slice(0, shown).join(", ")} +${items.length - shown} more`;
}
