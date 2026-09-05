/**
 * Default model metadata for Codex-style relays (272k context tier).
 * Matches the common GPT-5.6 Sol/Luna/Terra configuration used with transparent
 * sub2api / CPA / codex2api gateways after the product-side 372k rollback.
 *
 * Display name (`name`) is optional: omit it to show the model id in /model.
 */

import { DEFAULTS, ROUTER_THINKING_LEVELS, THINKING_LEVELS, type ThinkingLevel } from "./constants.ts";
import type { RelayModelConfig, ThinkingLevelMap } from "./types.ts";

/** Conservative defaults for newly added models only. */
export const DEFAULT_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

/** Optional custom label only — never invent a default name; empty means show id. */
export function createDefaultModelConfig(id: string, name?: string): RelayModelConfig {
	const trimmed = name?.trim();
	const config: RelayModelConfig = {
		id,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: DEFAULTS.contextWindow,
		maxTokens: DEFAULTS.maxTokens,
		thinkingLevelMap: { ...DEFAULT_THINKING_LEVEL_MAP },
	};
	if (trimmed && trimmed !== id) config.name = trimmed;
	return config;
}

/** Label for UI lists: custom name if set, otherwise id. */
export function displayModelLabel(entry: Pick<RelayModelConfig, "id" | "name">): string {
	const name = entry.name?.trim();
	return name && name !== entry.id ? name : entry.id;
}

/** Merge stored model entry with defaults so partial saves stay complete. */
export function resolveModelConfig(entry: RelayModelConfig): {
	id: string;
	name?: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap: ThinkingLevelMap;
} {
	const base = createDefaultModelConfig(entry.id);
	const name = entry.name?.trim();
	return {
		id: entry.id,
		...(name && name !== entry.id ? { name } : {}),
		reasoning: entry.reasoning ?? base.reasoning!,
		input: entry.input ?? base.input!,
		contextWindow: entry.contextWindow ?? base.contextWindow!,
		maxTokens: entry.maxTokens ?? Math.min(base.maxTokens!, entry.contextWindow ?? base.contextWindow!),
		thinkingLevelMap: resolveRouterThinkingMap(entry.thinkingLevelMap),
	};
}

export function normalizeThinkingMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap {
	const result: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		if (map && level in map) {
			const value = map[level];
			result[level] = value === undefined ? undefined : value;
		}
	}
	return result;
}

/** Preserve Pi omitted semantics; do not impose new-model defaults on existing maps. */
export function resolveRouterThinkingMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap {
	return normalizeThinkingMap(map);
}

export function summarizeThinkingMap(map: ThinkingLevelMap | undefined): string {
	const resolved = resolveRouterThinkingMap(map);
	const enabled: string[] = [];
	const hidden: string[] = [];
	for (const level of ROUTER_THINKING_LEVELS) {
		const value = resolved[level];
		if (value === null || (value === undefined && (level === "xhigh" || level === "max"))) hidden.push(level);
		else if (value === undefined) enabled.push(level);
		else enabled.push(level === value ? level : `${level}→${value}`);
	}
	const on = enabled.length > 0 ? enabled.join(", ") : "none";
	return hidden.length > 0 ? `${on} · hide ${hidden.join(",")}` : on;
}

export function toggleThinkingLevel(map: ThinkingLevelMap, level: ThinkingLevel): ThinkingLevelMap {
	const next = resolveRouterThinkingMap(map);
	if (!ROUTER_THINKING_LEVELS.includes(level as (typeof ROUTER_THINKING_LEVELS)[number])) return next;
	next[level] = next[level] === null ? level : null;
	return next;
}

/**
 * ProviderConfig model entry required by registerProvider.
 * Pi requires a `name` string; when the user left it empty we pass the id so /model shows the id.
 */
export function toRegisterModel(entry: RelayModelConfig) {
	const resolved = resolveModelConfig(entry);
	return {
		id: resolved.id,
		name: resolved.name ?? resolved.id,
		reasoning: resolved.reasoning,
		input: resolved.input,
		contextWindow: resolved.contextWindow,
		maxTokens: resolved.maxTokens,
		thinkingLevelMap: resolved.thinkingLevelMap,
		cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(entry.headers ? { headers: entry.headers } : {}),
	};
}
