import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import {
	SUBAGENT_AGENT_NAMES,
	SUBAGENT_CONFIG_FILE,
	SUBAGENT_CONFIG_VERSION,
	type SubagentAgentName,
	THINKING_LEVELS,
} from "./constants.ts";
import type { SubagentConfigFile, SubagentProfileOverride } from "./types.ts";

function isThinkingLevel(value: unknown): boolean {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

// Overrides hold concrete values only; absence means "inherit the parent
// session". The file format has no compatibility aliases.
function normalizeOverride(value: unknown, profile: string): SubagentProfileOverride {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Profile override for "${profile}" must be an object.`);
	}
	const input = value as Record<string, unknown>;
	const output: SubagentProfileOverride = {};
	if (input.model !== undefined) {
		if (typeof input.model !== "string" || input.model.trim().length === 0 || input.model === "inherit") {
			throw new Error(`Profile "${profile}" model override must be a concrete model id.`);
		}
		output.model = input.model.trim();
	}
	if (input.thinking !== undefined) {
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
	if (root.version !== SUBAGENT_CONFIG_VERSION) {
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
		// The only profiles are the two built-in ones; unknown keys are rejected
		// outright (no legacy aliases or compatibility mapping).
		if (!(SUBAGENT_AGENT_NAMES as readonly string[]).includes(name)) {
			throw new Error(`${SUBAGENT_CONFIG_FILE} contains unknown profile "${name}".`);
		}
		profiles[name] = normalizeOverride(value, name);
	}
	const unknownKeys = Object.keys(root).filter((key) => key !== "version" && key !== "profiles");
	if (unknownKeys.length > 0)
		throw new Error(`${SUBAGENT_CONFIG_FILE} has unsupported field(s): ${unknownKeys.join(", ")}.`);
	return { version: SUBAGENT_CONFIG_VERSION, profiles };
}

// A stale or invalid config (older formats, unknown profiles, malformed
// JSON) must not block every subagent call: reset it to an empty, fully
// inheriting config. The reset is best-effort — when the write fails the
// caller still gets the empty config and the next load retries the reset.
async function resetSubagentConfigFile(filePath: string): Promise<void> {
	try {
		await writeSubagentConfigFile(filePath, emptySubagentConfig());
	} catch {
		// Keep the original failure invisible to callers; an unwritable config
		// file is a setup problem, not a reason to fail the subagent call.
	}
}

export async function loadSubagentConfig(agentDir = getAgentDir()): Promise<SubagentConfigFile> {
	const filePath = getSubagentConfigPath(agentDir);
	try {
		return parseSubagentConfig(await readFile(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySubagentConfig();
		await resetSubagentConfigFile(filePath);
		return emptySubagentConfig();
	}
}

// Queue-free write body: read-modify-write callers run their whole
// transaction inside the queue, so saveSubagentConfig must not queue the
// same path again — that would deadlock.
async function writeSubagentConfigFile(filePath: string, config: SubagentConfigFile): Promise<void> {
	const payload = `${JSON.stringify({ version: SUBAGENT_CONFIG_VERSION, profiles: config.profiles }, null, 2)}\n`;
	await mkdir(dirname(filePath), { recursive: true });
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
}

// Only keys present in the patch change; a key set to undefined clears
// that override (back to inheriting the parent session).
export async function updateProfileOverride(
	profile: SubagentAgentName,
	patch: Partial<SubagentProfileOverride>,
	agentDir = getAgentDir(),
): Promise<SubagentConfigFile> {
	const filePath = getSubagentConfigPath(agentDir);
	// Load and write run inside one queue slot so concurrent updates to
	// different profiles cannot overwrite each other.
	return withFileMutationQueue(filePath, async () => {
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
		await writeSubagentConfigFile(filePath, config);
		return config;
	});
}
