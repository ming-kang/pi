/**
 * Built-in model catalog index and reference matching for Use Built-in Data.
 *
 * The index is built lazily on first use from pi-ai's raw builtin catalog
 * (never from the runtime's user-modified getAll()). Matching is grouped by
 * exact id, normalized id, then fuzzy match; ties prefer the current API.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { ModelsJsonModel } from "../../core/model-config.ts";
import { MAX_CANDIDATES, plural } from "./constants.ts";

export interface CatalogEntry {
	providerId: string;
	model: Model<Api>;
}

let indexCache: readonly CatalogEntry[] | undefined;

export function builtinCatalogIndex(): readonly CatalogEntry[] {
	if (indexCache) return indexCache;
	const entries: CatalogEntry[] = [];
	for (const providerId of getBuiltinProviders()) {
		for (const model of getBuiltinModels(providerId)) entries.push({ providerId, model });
	}
	indexCache = entries;
	return entries;
}

/** True when models.json with this provider id overlays a built-in catalog. */
export function isBuiltinProviderId(providerId: string): boolean {
	return (getBuiltinProviders() as readonly string[]).includes(providerId);
}

/**
 * Builtin fallback api/baseUrl for a custom model, mirroring the runtime's
 * findModelDefaults order: same id, then same api, then any openai-completions
 * model, then the first catalog entry.
 */
export function builtinDefaults(
	providerId: string,
	modelId?: string,
	api?: string,
): { api?: string; baseUrl?: string } {
	if (!isBuiltinProviderId(providerId)) return {};
	const models = getBuiltinModels(providerId as never) as readonly Model<Api>[];
	if (models.length === 0) return {};
	const found =
		(modelId ? models.find((model) => model.id === modelId) : undefined) ??
		(api ? models.find((model) => model.api === api) : undefined) ??
		models.find((model) => model.api === "openai-completions") ??
		models[0];
	return { api: found.api, baseUrl: found.baseUrl };
}

/** Case-insensitive, separator-tolerant comparison key; keeps version/date/thinking variants. */
function normalizeId(id: string): string {
	const basename = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	return basename
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export type MatchTier = "exact" | "normalized" | "fuzzy";

export interface CatalogMatch {
	entry: CatalogEntry;
	tier: MatchTier;
}

function sortTier(matches: CatalogMatch[], preferredApi: string | undefined): CatalogMatch[] {
	return matches.sort((a, b) => {
		if (preferredApi) {
			const aPreferred = a.entry.model.api === preferredApi ? 0 : 1;
			const bPreferred = b.entry.model.api === preferredApi ? 0 : 1;
			if (aPreferred !== bPreferred) return aPreferred - bPreferred;
		}
		return a.entry.model.id.localeCompare(b.entry.model.id);
	});
}

/** Grouped reference candidates for a query id; at most `max` entries, best first. */
export function matchBuiltinModels(query: string, preferredApi?: string, max: number = MAX_CANDIDATES): CatalogMatch[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const index = builtinCatalogIndex();
	const normalizedQuery = normalizeId(trimmed);
	const exact: CatalogMatch[] = [];
	const normalized: CatalogMatch[] = [];
	const consumed = new Set<CatalogEntry>();
	for (const entry of index) {
		if (entry.model.id === trimmed) {
			exact.push({ entry, tier: "exact" });
			consumed.add(entry);
		} else if (normalizeId(entry.model.id) === normalizedQuery) {
			normalized.push({ entry, tier: "normalized" });
			consumed.add(entry);
		}
	}
	const remaining = sortTier(
		index.filter((entry) => !consumed.has(entry)).map((entry) => ({ entry, tier: "fuzzy" })),
		preferredApi,
	);
	const fuzzy: CatalogMatch[] = fuzzyFilter(
		remaining,
		trimmed,
		({ entry }) => `${entry.model.id} ${entry.model.name} ${entry.providerId}`,
	);
	return [...sortTier(exact, preferredApi), ...sortTier(normalized, preferredApi), ...fuzzy].slice(0, max);
}

export type ReferenceField =
	| "name"
	| "reasoning"
	| "input"
	| "contextWindow"
	| "maxTokens"
	| "thinkingLevelMap"
	| "compat"
	| "cost";

export interface FieldChange {
	field: ReferenceField;
	/** Pre-selected per the completion rules (unset scalar fields are checked; map/compat/cost never are). */
	checked: boolean;
	/** False = cross-API map/compat: view-only, cannot be applied. */
	applicable: boolean;
	/** Left side of the preview, e.g. `unset (falls back to id)`. */
	currentText: string;
	/** Right side of the preview, e.g. the reference value. */
	referenceText: string;
	/** Extra detail lines for the expandable view (thinking map entries, compat keys, cost rates). */
	referenceDetails?: string[];
	/** Reference carries tiers; applying cost keeps current tiers and never imports reference tiers. */
	referenceHasTiers?: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

function formatCostRates(cost: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
	return `$${cost.input} / $${cost.output} in/out (cache $${cost.cacheRead} / $${cost.cacheWrite})`;
}

/**
 * Compute the per-field change list for applying `reference` onto `current`.
 * Only fields the reference actually has appear; an absent map/compat on the
 * reference never implies clearing the current value.
 */
export function computeFieldChanges(
	current: Partial<ModelsJsonModel> & { id?: string },
	reference: Model<Api>,
	effectiveApi: string | undefined,
): FieldChange[] {
	const changes: FieldChange[] = [];
	const unset = (key: keyof ModelsJsonModel) => current[key] === undefined;

	changes.push({
		field: "name",
		checked: unset("name") && reference.name !== reference.id,
		applicable: true,
		currentText: current.name ?? `unset (falls back to id${current.id ? ` "${current.id}"` : ""})`,
		referenceText: reference.name,
	});
	changes.push({
		field: "reasoning",
		checked: unset("reasoning") && reference.reasoning === true,
		applicable: true,
		currentText: current.reasoning === undefined ? "false (default)" : String(current.reasoning),
		referenceText: String(reference.reasoning),
	});
	changes.push({
		field: "input",
		checked: unset("input"),
		applicable: true,
		currentText: current.input ? current.input.join(", ") : "text (default)",
		referenceText: reference.input.join(", "),
	});
	changes.push({
		field: "contextWindow",
		checked: unset("contextWindow"),
		applicable: true,
		currentText:
			current.contextWindow === undefined ? `${DEFAULT_CONTEXT_WINDOW} (default)` : String(current.contextWindow),
		referenceText: String(reference.contextWindow),
	});
	changes.push({
		field: "maxTokens",
		checked: unset("maxTokens"),
		applicable: true,
		currentText: current.maxTokens === undefined ? `${DEFAULT_MAX_TOKENS} (default)` : String(current.maxTokens),
		referenceText: String(reference.maxTokens),
	});

	const sameApi = effectiveApi !== undefined && reference.api === effectiveApi;
	if (reference.thinkingLevelMap && Object.keys(reference.thinkingLevelMap).length > 0) {
		const details = Object.entries(reference.thinkingLevelMap).map(
			([level, target]) => `${level}: ${target === null ? "null (hidden)" : target}`,
		);
		changes.push({
			field: "thinkingLevelMap",
			checked: false,
			applicable: sameApi,
			currentText: current.thinkingLevelMap
				? `${Object.keys(current.thinkingLevelMap).length} ${plural(Object.keys(current.thinkingLevelMap).length, "mapping")}`
				: "unset",
			// Cross-api maps are view-only; the preview pane annotates that.
			referenceText: `${details.length} ${plural(details.length, "mapping")}`,
			referenceDetails: details,
		});
	}
	if (reference.compat && Object.keys(reference.compat).length > 0) {
		const details = Object.entries(reference.compat).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
		changes.push({
			field: "compat",
			checked: false,
			applicable: sameApi,
			currentText: current.compat
				? `${Object.keys(current.compat).length} ${plural(Object.keys(current.compat).length, "entry")}`
				: "unset",
			referenceText: `${details.length} ${plural(details.length, "entry")}`,
			referenceDetails: details,
		});
	}
	if (reference.cost) {
		changes.push({
			field: "cost",
			checked: false,
			applicable: true,
			currentText: current.cost ? formatCostRates(current.cost) : "all 0 (default)",
			referenceText: formatCostRates(reference.cost),
			referenceDetails: [
				`input: $${reference.cost.input} / M tokens`,
				`output: $${reference.cost.output} / M tokens`,
				`cacheRead: $${reference.cost.cacheRead} / M tokens`,
				`cacheWrite: $${reference.cost.cacheWrite} / M tokens`,
			],
			referenceHasTiers: Array.isArray(reference.cost.tiers) && reference.cost.tiers.length > 0,
		});
	}
	return changes;
}
