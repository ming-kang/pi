/**
 * Persistence for ~/.pi/agent/router.json
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { CONFIG_VERSION, isValidRelayId, THINKING_LEVELS } from "./constants.ts";
import type { RelayConfig, RelayModelConfig, RouterFile, ThinkingLevelMap } from "./types.ts";

const ROOT_FIELDS = ["version", "relays"] as const;
const RELAY_FIELDS = ["id", "baseUrl", "apiKey", "models"] as const;
const MODEL_FIELDS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "thinkingLevelMap"] as const;

export function getRouterConfigPath(): string {
	return join(getAgentDir(), "router.json");
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

function expectObject(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new Error(`${path} has unsupported field(s): ${unknown.join(", ")}.`);
}

function expectString(value: unknown, path: string, allowEmpty = false): string {
	if (typeof value !== "string") throw new Error(`${path} must be a string.`);
	const trimmed = value.trim();
	if (!allowEmpty && !trimmed) throw new Error(`${path} must not be empty.`);
	return allowEmpty ? value : trimmed;
}

function expectPositiveInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${path} must be a positive integer.`);
	}
	return value;
}

export function parseRouterFile(raw: string): RouterFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("router.json is not valid JSON.");
	}
	const root = expectObject(parsed, "router.json");
	rejectUnknownFields(root, ROOT_FIELDS, "router.json");
	const version = root.version ?? CONFIG_VERSION;
	if (version !== CONFIG_VERSION) {
		throw new Error(`router.json has unsupported version ${String(version)}.`);
	}
	if (root.relays !== undefined && !Array.isArray(root.relays)) {
		throw new Error("router.json relays must be an array.");
	}

	const relays = ((root.relays as unknown[] | undefined) ?? []).map((value, index) =>
		parseRelay(value, `router.json relays[${index}]`),
	);
	const relayIds = new Set<string>();
	for (const relay of relays) {
		if (relayIds.has(relay.id)) throw new Error(`router.json contains duplicate relay id "${relay.id}".`);
		relayIds.add(relay.id);
	}
	return { version: CONFIG_VERSION, relays };
}

function parseRelay(value: unknown, path: string): RelayConfig {
	const record = expectObject(value, path);
	rejectUnknownFields(record, RELAY_FIELDS, path);
	const id = expectString(record.id, `${path}.id`);
	if (!isValidRelayId(id)) throw new Error(`${path}.id must be a valid provider id without '/'.`);
	const baseUrl = expectString(record.baseUrl, `${path}.baseUrl`);
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
	} catch {
		throw new Error(`${path}.baseUrl must be an http or https URL.`);
	}
	const apiKey = expectString(record.apiKey, `${path}.apiKey`, true);
	if (record.models !== undefined && !Array.isArray(record.models)) {
		throw new Error(`${path}.models must be an array.`);
	}
	const models = ((record.models as unknown[] | undefined) ?? []).map((model, index) =>
		parseModel(model, `${path}.models[${index}]`),
	);
	const modelIds = new Set<string>();
	for (const model of models) {
		if (modelIds.has(model.id)) throw new Error(`${path}.models contains duplicate id "${model.id}".`);
		modelIds.add(model.id);
	}
	return { id, baseUrl, apiKey, models };
}

function parseModel(value: unknown, path: string): RelayModelConfig {
	const record = expectObject(value, path);
	rejectUnknownFields(record, MODEL_FIELDS, path);
	const model: RelayModelConfig = { id: expectString(record.id, `${path}.id`) };
	if (record.name !== undefined) {
		const name = expectString(record.name, `${path}.name`, true).trim();
		if (name) model.name = name;
	}
	if (record.reasoning !== undefined) {
		if (typeof record.reasoning !== "boolean") throw new Error(`${path}.reasoning must be a boolean.`);
		model.reasoning = record.reasoning;
	}
	if (record.input !== undefined) {
		if (!Array.isArray(record.input) || record.input.some((item) => item !== "text" && item !== "image")) {
			throw new Error(`${path}.input must contain only "text" and "image".`);
		}
		const input = new Set(record.input as Array<"text" | "image">);
		if (!input.has("text")) throw new Error(`${path}.input must include "text".`);
		model.input = input.has("image") ? ["text", "image"] : ["text"];
	}
	if (record.contextWindow !== undefined) {
		model.contextWindow = expectPositiveInteger(record.contextWindow, `${path}.contextWindow`);
	}
	if (record.maxTokens !== undefined) {
		model.maxTokens = expectPositiveInteger(record.maxTokens, `${path}.maxTokens`);
	}
	if (record.thinkingLevelMap !== undefined) {
		model.thinkingLevelMap = parseThinkingLevelMap(record.thinkingLevelMap, `${path}.thinkingLevelMap`);
	}
	return model;
}

function parseThinkingLevelMap(value: unknown, path: string): ThinkingLevelMap {
	const record = expectObject(value, path);
	const map: ThinkingLevelMap = {};
	for (const [level, target] of Object.entries(record)) {
		if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
			throw new Error(`${path} has unsupported thinking level "${level}".`);
		}
		if (target !== null && (typeof target !== "string" || target.trim().length === 0)) {
			throw new Error(`${path}.${level} must be a non-empty string or null.`);
		}
		map[level as keyof ThinkingLevelMap] = target === null ? null : target.trim();
	}
	return map;
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
				// Ignore cleanup errors and preserve the original failure.
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
