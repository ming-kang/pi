import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
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

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_OPTIONS = { retries: 5, factor: 2, minTimeout: 20, maxTimeout: 200 } as const;
const BACKUP_ATTEMPTS = 100;

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
		if (!(SUBAGENT_AGENT_NAMES as readonly string[]).includes(name)) {
			throw new Error(`${SUBAGENT_CONFIG_FILE} contains unknown profile "${name}".`);
		}
		profiles[name] = normalizeOverride(value, name);
	}
	const unknownKeys = Object.keys(root).filter((key) => key !== "version" && key !== "profiles");
	if (unknownKeys.length > 0) {
		throw new Error(`${SUBAGENT_CONFIG_FILE} has unsupported field(s): ${unknownKeys.join(", ")}.`);
	}
	return { version: SUBAGENT_CONFIG_VERSION, profiles };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function configWarning(filePath: string, error: unknown): string {
	return `Ignoring invalid Subagent settings at ${filePath}; the file was left unchanged. ${errorMessage(error)}`;
}

export async function loadSubagentConfig(
	agentDir = getAgentDir(),
	onWarning?: (message: string) => void,
): Promise<SubagentConfigFile> {
	const filePath = getSubagentConfigPath(agentDir);
	try {
		return parseSubagentConfig(await readFile(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySubagentConfig();
		onWarning?.(configWarning(filePath, error));
		return emptySubagentConfig();
	}
}

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

async function backUpInvalidConfig(filePath: string, raw: string): Promise<string> {
	for (let attempt = 0; attempt < BACKUP_ATTEMPTS; attempt++) {
		const suffix = attempt === 0 ? "" : `-${attempt}`;
		const backupPath = `${filePath}.invalid-${Date.now()}-${process.pid}${suffix}.bak`;
		try {
			await writeFile(backupPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
			return backupPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw new Error(`Could not back up invalid ${SUBAGENT_CONFIG_FILE}: ${errorMessage(error)}`);
		}
	}
	throw new Error(`Could not allocate a backup path for invalid ${SUBAGENT_CONFIG_FILE}.`);
}

async function withSubagentConfigLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(dirname(filePath), { recursive: true });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(filePath, {
			realpath: false,
			stale: LOCK_STALE_MS,
			retries: LOCK_RETRY_OPTIONS,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
			throw new Error(`Timed out waiting to update ${SUBAGENT_CONFIG_FILE}; another Pi process is saving it.`);
		}
		throw error;
	}
	try {
		return await fn();
	} finally {
		await release();
	}
}

interface MutationConfigRead {
	config: SubagentConfigFile;
	invalidRaw?: string;
}

async function readConfigForMutation(filePath: string): Promise<MutationConfigRead> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: emptySubagentConfig() };
		throw error;
	}
	try {
		return { config: parseSubagentConfig(raw) };
	} catch {
		return { config: emptySubagentConfig(), invalidRaw: raw };
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
	return withFileMutationQueue(filePath, () =>
		withSubagentConfigLock(filePath, async () => {
			const { config, invalidRaw } = await readConfigForMutation(filePath);
			const currentOverride = config.profiles[profile];
			const current = currentOverride ?? {};
			const next: SubagentProfileOverride = { ...current };
			if ("model" in patch) {
				if (patch.model === undefined) delete next.model;
				else next.model = patch.model;
			}
			if ("thinking" in patch) {
				if (patch.thinking === undefined) delete next.thinking;
				else next.thinking = patch.thinking;
			}
			const hasNext = Object.keys(next).length > 0;
			const changed =
				(currentOverride !== undefined) !== hasNext ||
				current.model !== next.model ||
				current.thinking !== next.thinking;
			if (!changed) return config;
			if (invalidRaw !== undefined) await backUpInvalidConfig(filePath, invalidRaw);
			if (hasNext) config.profiles[profile] = next;
			else delete config.profiles[profile];
			await writeSubagentConfigFile(filePath, config);
			return config;
		}),
	);
}
