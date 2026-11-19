import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Files one Agent task keeps beside the session that launched it, so they outlive Tasks retention and restore. */
export interface AgentArtifacts {
	dir: string;
	reportPath: string;
	transcriptPath: string;
	/** The launching session file, recorded as the transcript's parent. */
	parentSession?: string;
}

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
