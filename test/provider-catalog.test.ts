import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	builtinCatalogIndex,
	builtinDefaults,
	computeFieldChanges,
	isBuiltinProviderId,
	matchBuiltinModels,
} from "../src/extensions/provider/catalog.ts";

describe("provider builtin catalog", () => {
	test("builds the index lazily from the raw builtin catalog", () => {
		const index = builtinCatalogIndex();
		expect(index.length).toBeGreaterThan(1000);
		expect(index.some((entry) => entry.providerId === "anthropic" && entry.model.id === "claude-opus-4-6")).toBe(
			true,
		);
	});

	test("exact id matches come first, then normalized, then fuzzy", () => {
		const matches = matchBuiltinModels("claude-opus-4-6");
		expect(matches[0]?.tier).toBe("exact");
		expect(matches[0]?.entry.model.id).toBe("claude-opus-4-6");
		expect(matches.length).toBeLessThanOrEqual(8);
	});

	test("normalized matching tolerates case, separators, and source prefixes", () => {
		const matches = matchBuiltinModels("Kimi K3");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.tier === "normalized" || matches[0]?.tier === "exact").toBe(true);
		expect(matches[0]?.entry.model.id.toLowerCase()).toContain("kimi");
	});

	test("fuzzy matching finds abbreviation-ish queries", () => {
		const matches = matchBuiltinModels("opus46");
		expect(matches.some((match) => match.entry.model.id.includes("opus"))).toBe(true);
	});

	test("preserves relevance instead of alphabetically promoting unrelated fuzzy hits", () => {
		expect(matchBuiltinModels("sol")[0]?.entry.model.id.toLowerCase()).toContain("sol");
	});

	test("the preferred api sorts first within a tier", () => {
		const matches = matchBuiltinModels("claude-opus-4-6", "anthropic-messages");
		const exact = matches.filter((match) => match.tier === "exact");
		expect(exact.length).toBeGreaterThan(1);
		expect(exact[0]?.entry.model.api).toBe("anthropic-messages");
	});

	test("empty queries match nothing", () => {
		expect(matchBuiltinModels("   ")).toEqual([]);
	});

	test("builtin overlay detection and defaults mirror findModelDefaults", () => {
		expect(isBuiltinProviderId("anthropic")).toBe(true);
		expect(isBuiltinProviderId("definitely-not-a-provider")).toBe(false);
		const defaults = builtinDefaults("anthropic", "claude-opus-4-6");
		expect(defaults.api).toBe("anthropic-messages");
		expect(defaults.baseUrl).toContain("anthropic.com");
		expect(builtinDefaults("definitely-not-a-provider")).toEqual({});
	});
});

describe("provider field-change computation", () => {
	const reference = {
		id: "moonshotai/Kimi-K3",
		name: "Kimi K3",
		api: "openai-completions",
		provider: "baseten",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.6, output: 2.5, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 1048576,
		maxTokens: 262144,
		thinkingLevelMap: { high: "high" },
		compat: { supportsStore: false },
	} as unknown as Model<Api>;

	test("unset scalar fields are pre-checked; explicitly configured values stay unchecked", () => {
		const unset = computeFieldChanges({ id: "k3" }, reference, "openai-completions");
		const byField = Object.fromEntries(unset.map((change) => [change.field, change]));
		expect(byField.name?.checked).toBe(true);
		expect(byField.reasoning?.checked).toBe(true);
		expect(byField.input?.checked).toBe(true);
		expect(byField.contextWindow?.checked).toBe(true);
		expect(byField.maxTokens?.checked).toBe(true);
		// map/compat/cost never pre-checked
		expect(byField.thinkingLevelMap?.checked).toBe(false);
		expect(byField.compat?.checked).toBe(false);
		expect(byField.cost?.checked).toBe(false);

		const explicit = computeFieldChanges(
			{ id: "k3", reasoning: false, contextWindow: 128000 },
			reference,
			"openai-completions",
		);
		const explicitByField = Object.fromEntries(explicit.map((change) => [change.field, change]));
		// Explicitly configured values stay unchecked even when equal to a Pi default.
		expect(explicitByField.reasoning?.checked).toBe(false);
		expect(explicitByField.contextWindow?.checked).toBe(false);
	});

	test("cross-api thinking maps and compat are view-only", () => {
		const changes = computeFieldChanges({ id: "k3" }, reference, "anthropic-messages");
		const byField = Object.fromEntries(changes.map((change) => [change.field, change]));
		expect(byField.thinkingLevelMap?.applicable).toBe(false);
		expect(byField.compat?.applicable).toBe(false);
		// scalars stay applicable regardless of api
		expect(byField.contextWindow?.applicable).toBe(true);
	});

	test("missing reference map/compat produce no clear-the-current-value rows", () => {
		const bare = { ...reference, thinkingLevelMap: undefined, compat: undefined } as unknown as Model<Api>;
		const changes = computeFieldChanges({ id: "k3", thinkingLevelMap: { high: "max" } }, bare, "openai-completions");
		expect(changes.some((change) => change.field === "thinkingLevelMap")).toBe(false);
		expect(changes.some((change) => change.field === "compat")).toBe(false);
	});

	test("reference cost tiers are flagged, never imported", () => {
		const tiered = {
			...reference,
			cost: {
				...reference.cost,
				tiers: [{ inputTokensAbove: 1000, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }],
			},
		} as unknown as Model<Api>;
		const changes = computeFieldChanges({ id: "k3" }, tiered, "openai-completions");
		const cost = changes.find((change) => change.field === "cost");
		expect(cost?.referenceHasTiers).toBe(true);
		expect(cost?.checked).toBe(false);
	});
});
