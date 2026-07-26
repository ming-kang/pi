import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { SUBAGENT_CONFIG_FILE, SUBAGENT_CONFIG_VERSION, THINKING_LEVELS } from "./constants.ts";
import type { SubagentConfigFile, SubagentProfileOverride } from "./types.ts";

function isThinkingLevel(value: unknown): boolean {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

// Overrides hold concrete values only; absence means "inherit the parent
// session". Legacy "inherit" entries from earlier versions are dropped.
function normalizeOverride(value: unknown, profile: string): SubagentProfileOverride {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Profile override for "${profile}" must be an object.`);
	}
	const input = value as Record<string, unknown>;
	const output: SubagentProfileOverride = {};
	if (input.model !== undefined && input.model !== "inherit") {
		if (typeof input.model !== "string" || input.model.trim().length === 0) {
			throw new Error(`Profile "${profile}" model override must be a model id.`);
		}
		output.model = input.model.trim();
	}
	if (input.thinking !== undefined && input.thinking !== "inherit") {
		if (!isThinkingLevel(input.thinking)) {
			throw new Error(`Profile "${profile}" thinking override is invalid.`);
		}
		output.thinking = input.thinking as SubagentProfileOverride["thinking"];
	}
	const unknownKeys = Object.keys(input).filter((key) => key !== "model" && key !== "thinking");
	if (unknownKeys.length > 0) {
		throw new Error(`Profile "${profile}" has unsupported setting(s): ${unknownKeys.join(", ")}.`);
	}
	return output;
}

export function getSubagentConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, SUBAGENT_CONFIG_FILE);
}

export function emptySubagentConfig(): SubagentConfigFile {
	return { version: SUBAGENT_CONFIG_VERSION, profiles: {} };
}

export function parseSubagentConfig(raw: string): SubagentConfigFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${SUBAGENT_CONFIG_FILE} is not valid JSON.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${SUBAGENT_CONFIG_FILE} must be a JSON object.`);
	}
	const root = parsed as Record<string, unknown>;
	if (root.version !== undefined && root.version !== SUBAGENT_CONFIG_VERSION) {
		throw new Error(`${SUBAGENT_CONFIG_FILE} has unsupported version ${String(root.version)}.`);
	}
	if (
		root.profiles !== undefined &&
		(!root.profiles || typeof root.profiles !== "object" || Array.isArray(root.profiles))
	) {
		throw new Error(`${SUBAGENT_CONFIG_FILE} profiles must be an object.`);
	}
	const profiles: Record<string, SubagentProfileOverride> = {};
	for (const [name, value] of Object.entries((root.profiles as Record<string, unknown> | undefined) ?? {})) {
		if (!name.trim()) throw new Error(`${SUBAGENT_CONFIG_FILE} contains an empty profile name.`);
		profiles[name] = normalizeOverride(value, name);
	}
	const unknownKeys = Object.keys(root).filter((key) => key !== "version" && key !== "profiles");
	if (unknownKeys.length > 0)
		throw new Error(`${SUBAGENT_CONFIG_FILE} has unsupported field(s): ${unknownKeys.join(", ")}.`);
	return { version: SUBAGENT_CONFIG_VERSION, profiles };
}

export async function loadSubagentConfig(agentDir = getAgentDir()): Promise<SubagentConfigFile> {
	const filePath = getSubagentConfigPath(agentDir);
	try {
		return parseSubagentConfig(await readFile(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySubagentConfig();
		throw error;
	}
}

export async function saveSubagentConfig(config: SubagentConfigFile, agentDir = getAgentDir()): Promise<void> {
	const filePath = getSubagentConfigPath(agentDir);
	const payload = `${JSON.stringify({ version: SUBAGENT_CONFIG_VERSION, profiles: config.profiles }, null, 2)}\n`;
	await mkdir(dirname(filePath), { recursive: true });
	await withFileMutationQueue(filePath, async () => {
		const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
			await rename(tempPath, filePath);
		} catch (error) {
			try {
				await unlink(tempPath);
			} catch {
				// Ignore cleanup errors and preserve the original failure.
			}
			throw error;
		}
	});
}

// Only keys present in the patch change; a key set to undefined clears
// that override (back to inheriting the parent session).
export async function updateProfileOverride(
	profile: string,
	patch: Partial<SubagentProfileOverride>,
	agentDir = getAgentDir(),
): Promise<SubagentConfigFile> {
	const config = await loadSubagentConfig(agentDir);
	const current = config.profiles[profile] ?? {};
	const next: SubagentProfileOverride = { ...current };
	if ("model" in patch) {
		if (patch.model === undefined) delete next.model;
		else next.model = patch.model;
	}
	if ("thinking" in patch) {
		if (patch.thinking === undefined) delete next.thinking;
		else next.thinking = patch.thinking;
	}
	if (Object.keys(next).length === 0) delete config.profiles[profile];
	else config.profiles[profile] = next;
	await saveSubagentConfig(config, agentDir);
	return config;
}

export async function resetProfileOverrides(agentDir = getAgentDir()): Promise<void> {
	await saveSubagentConfig(emptySubagentConfig(), agentDir);
}
