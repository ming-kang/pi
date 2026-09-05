/**
 * Persistence for ~/.pi/agent/router.json
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";
import { CONFIG_VERSION, DEFAULTS, isValidRelayId, THINKING_LEVELS } from "./constants.ts";
import type { RelayConfig, RelayModelConfig, RouterFile, ThinkingLevelMap } from "./types.ts";

const ROOT_FIELDS = ["version", "relays"] as const;
const RELAY_FIELDS = ["id", "name", "baseUrl", "apiKey", "models", "headers", "catalog"] as const;
const MODEL_FIELDS = [
	"id",
	"name",
	"reasoning",
	"input",
	"contextWindow",
	"maxTokens",
	"thinkingLevelMap",
	"codex",
	"headers",
	"cost",
] as const;

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
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
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
		if (url.username || url.password || url.hash) throw new Error("credentials or fragment");
	} catch {
		throw new Error(`${path}.baseUrl must be an http or https URL without embedded credentials or a fragment.`);
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
	const relay: RelayConfig = { id, baseUrl, apiKey, models };
	if (record.name !== undefined) relay.name = expectString(record.name, `${path}.name`);
	if (record.headers !== undefined) relay.headers = parseHeaders(record.headers, `${path}.headers`);
	if (record.catalog !== undefined) {
		if (record.catalog !== "openai" && record.catalog !== "codex")
			throw new Error(`${path}.catalog must be openai or codex.`);
		relay.catalog = record.catalog;
	}
	return relay;
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
	if (model.maxTokens !== undefined && model.maxTokens > (model.contextWindow ?? DEFAULTS.contextWindow))
		throw new Error(`${path}.maxTokens must not exceed contextWindow.`);
	if (record.headers !== undefined) model.headers = parseHeaders(record.headers, `${path}.headers`);
	if (record.codex !== undefined) {
		const codex = expectObject(record.codex, `${path}.codex`);
		rejectUnknownFields(codex, ["reasoningSummary", "verbosity", "parallelToolCalls"], `${path}.codex`);
		for (const field of ["reasoningSummary", "verbosity"] as const) {
			const value = codex[field];
			const allowed = field === "reasoningSummary" ? ["auto", "concise", "detailed"] : ["low", "medium", "high"];
			if (value === undefined) continue;
			if (value !== null && (typeof value !== "string" || !allowed.includes(value)))
				throw new Error(`${path}.codex.${field} has an invalid value.`);
		}
		if (codex.parallelToolCalls !== undefined && typeof codex.parallelToolCalls !== "boolean")
			throw new Error(`${path}.codex.parallelToolCalls must be a boolean.`);
		model.codex = codex as NonNullable<RelayModelConfig["codex"]>;
	}
	if (record.cost !== undefined) {
		const cost = expectObject(record.cost, `${path}.cost`);
		const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
		rejectUnknownFields(cost, fields, `${path}.cost`);
		for (const field of fields) {
			const value = cost[field];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
				throw new Error(`${path}.cost.${field} must be a finite non-negative number.`);
		}
		model.cost = cost as NonNullable<RelayModelConfig["cost"]>;
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

function parseHeaders(value: unknown, path: string): Record<string, string> {
	const record = expectObject(value, path);
	for (const [key, value] of Object.entries(record)) {
		if (
			!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
			typeof value !== "string" ||
			[...value].some((char) => [0, 10, 13].includes(char.charCodeAt(0)))
		)
			throw new Error(`${path}.${key} must be a valid header with a string value.`);
	}
	return record as Record<string, string>;
}

export async function saveRouterFile(file: RouterFile): Promise<void> {
	const snapshot = parseRouterFile(JSON.stringify(file));
	await withFileMutationQueue(getRouterConfigPath(), () => writeRouterFile(snapshot));
}

async function writeRouterFile(file: RouterFile): Promise<void> {
	const filePath = getRouterConfigPath();
	const serialized = `${JSON.stringify(parseRouterFile(JSON.stringify(file)), null, 2)}
`;
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, filePath);
	} catch (error) {
		try {
			await unlink(tempPath);
		} catch {
			/* Preserve original failure. */
		}
		throw error;
	}
}

export async function upsertRelay(relay: RelayConfig): Promise<RouterFile> {
	const snapshot = structuredClone(relay);
	return withFileMutationQueue(getRouterConfigPath(), async () => {
		const file = await loadRouterFile();
		const index = file.relays.findIndex((entry) => entry.id === snapshot.id);
		if (index >= 0) file.relays[index] = snapshot;
		else file.relays.push(snapshot);
		await writeRouterFile(file);
		return file;
	});
}

export async function removeRelay(id: string): Promise<RouterFile> {
	return withFileMutationQueue(getRouterConfigPath(), async () => {
		const file = await loadRouterFile();
		file.relays = file.relays.filter((entry) => entry.id !== id);
		await writeRouterFile(file);
		return file;
	});
}
