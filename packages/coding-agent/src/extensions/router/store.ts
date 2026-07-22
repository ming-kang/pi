/**
 * Persistence for ~/.pi/agent/pi-config/router.json
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { CONFIG_VERSION, isValidRelayId } from "./constants.ts";
import type { RelayConfig, RelayModelConfig, RouterFile, ThinkingLevelMap } from "./types.ts";

export function getRouterConfigPath(): string {
	return join(getAgentDir(), "pi-config", "router.json");
}

export function emptyRouterFile(): RouterFile {
	return { version: CONFIG_VERSION, relays: [] };
}

export async function loadRouterFile(): Promise<RouterFile> {
	const filePath = getRouterConfigPath();
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRouterFile();
		throw error;
	}
	return parseRouterFile(raw);
}

export function parseRouterFile(raw: string): RouterFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("router.json is not valid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("router.json must be a JSON object.");
	}
	const root = parsed as Record<string, unknown>;
	const relaysRaw = root.relays;
	if (relaysRaw !== undefined && !Array.isArray(relaysRaw)) {
		throw new Error("router.json relays must be an array.");
	}
	const relays: RelayConfig[] = [];
	for (const item of relaysRaw ?? []) {
		const relay = normalizeRelay(item);
		if (relay) relays.push(relay);
	}
	return { version: CONFIG_VERSION, relays };
}

function normalizeRelay(value: unknown): RelayConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
	const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
	if (!id || !isValidRelayId(id) || !baseUrl) return undefined;
	const models: RelayModelConfig[] = [];
	if (Array.isArray(record.models)) {
		for (const model of record.models) {
			const normalized = normalizeModel(model);
			if (normalized) models.push(normalized);
		}
	}
	return { id, baseUrl, apiKey, models };
}

function normalizeModel(value: unknown): RelayModelConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) return undefined;
	const model: RelayModelConfig = { id };
	if (typeof record.name === "string" && record.name.trim()) model.name = record.name.trim();
	if (typeof record.reasoning === "boolean") model.reasoning = record.reasoning;
	if (Array.isArray(record.input)) {
		const input = record.input.filter((item): item is "text" | "image" => item === "text" || item === "image");
		if (input.includes("text")) model.input = input.includes("image") ? ["text", "image"] : ["text"];
	}
	if (typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow) && record.contextWindow > 0) {
		model.contextWindow = Math.floor(record.contextWindow);
	}
	if (typeof record.maxTokens === "number" && Number.isFinite(record.maxTokens) && record.maxTokens > 0) {
		model.maxTokens = Math.floor(record.maxTokens);
	}
	if (
		record.thinkingLevelMap &&
		typeof record.thinkingLevelMap === "object" &&
		!Array.isArray(record.thinkingLevelMap)
	) {
		model.thinkingLevelMap = record.thinkingLevelMap as ThinkingLevelMap;
	}
	return model;
}

export async function saveRouterFile(file: RouterFile): Promise<void> {
	const filePath = getRouterConfigPath();
	const payload: RouterFile = {
		version: CONFIG_VERSION,
		relays: file.relays.map((relay) => ({
			id: relay.id,
			baseUrl: relay.baseUrl,
			apiKey: relay.apiKey,
			models: relay.models.map((model) => serializeModel(model)),
		})),
	};
	const serialized = `${JSON.stringify(payload, null, 2)}\n`;
	await mkdir(dirname(filePath), { recursive: true });
	await withFileMutationQueue(filePath, async () => {
		const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
			await rename(tempPath, filePath);
		} catch (error) {
			try {
				await unlink(tempPath);
			} catch {
				// ignore
			}
			throw error;
		}
	});
}

function serializeModel(model: RelayModelConfig): RelayModelConfig {
	const out: RelayModelConfig = { id: model.id };
	if (model.name) out.name = model.name;
	if (model.reasoning !== undefined) out.reasoning = model.reasoning;
	if (model.input) out.input = model.input;
	if (model.contextWindow !== undefined) out.contextWindow = model.contextWindow;
	if (model.maxTokens !== undefined) out.maxTokens = model.maxTokens;
	if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) {
		out.thinkingLevelMap = model.thinkingLevelMap;
	}
	return out;
}

export async function upsertRelay(relay: RelayConfig): Promise<RouterFile> {
	const file = await loadRouterFile();
	const index = file.relays.findIndex((entry) => entry.id === relay.id);
	if (index >= 0) file.relays[index] = relay;
	else file.relays.push(relay);
	await saveRouterFile(file);
	return file;
}

export async function removeRelay(id: string): Promise<RouterFile> {
	const file = await loadRouterFile();
	file.relays = file.relays.filter((entry) => entry.id !== id);
	await saveRouterFile(file);
	return file;
}
