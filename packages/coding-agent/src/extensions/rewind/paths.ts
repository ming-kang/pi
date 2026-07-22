import { join } from "node:path";

import { getAgentDir } from "../../config.ts";

function rewindDirectory(): string {
	return join(getAgentDir(), "rewind");
}

export function rewindConfigPath(): string {
	return join(rewindDirectory(), "config.json");
}

export function rewindBackupsRoot(): string {
	return join(rewindDirectory(), "backups");
}

export function sessionsDirectory(): string {
	return join(getAgentDir(), "sessions");
}
