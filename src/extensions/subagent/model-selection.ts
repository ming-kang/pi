import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { SubagentProfileOverride } from "./types.ts";

/** The registry surface model selection needs; ParentModelContext satisfies it. */
export type ModelRegistryLike = Pick<ModelRegistry, "find" | "getAvailable" | "hasConfiguredAuth">;

export function modelId(model: Pick<Model<Api>, "provider" | "id"> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "none";
}

export function parseModelSpec(value: string): { provider: string; id: string } {
	const separator = value.indexOf("/");
	return separator > 0
		? { provider: value.slice(0, separator), id: value.slice(separator + 1) }
		: { provider: "", id: value };
}

export function findModel(models: readonly Model<Api>[], value: string | undefined): Model<Api> | undefined {
	if (!value) return undefined;
	return models.find((model) => modelId(model) === value);
}

// Resolves a user/model-facing model spec against the live registry; errors
// are part of the contract (wording is asserted by config/resolve tests).
export function findAvailableModel(spec: string, registry: ModelRegistryLike): Model<Api> {
	const normalized = spec.trim();
	let model: Model<Api> | undefined;
	if (normalized.includes("/")) {
		const { provider, id } = parseModelSpec(normalized);
		model = registry.find(provider, id);
	} else {
		const matches = registry.getAvailable().filter((candidate) => candidate.id === normalized);
		if (matches.length === 1) model = matches[0];
		if (matches.length > 1) throw new Error(`Model id "${normalized}" is ambiguous; use provider/model.`);
	}
	if (!model) throw new Error(`Model "${normalized}" is not available.`);
	if (!registry.hasConfiguredAuth(model)) throw new Error(`Model "${normalized}" has no configured authentication.`);
	return model;
}

// Capability checks use the saved model when it is still in the catalog,
// falling back to the parent session model otherwise.
export function effectiveModel(
	currentSessionModel: Model<Api> | undefined,
	models: readonly Model<Api>[],
	override: SubagentProfileOverride | undefined,
): Model<Api> | undefined {
	if (override?.model) {
		const saved = findModel(models, override.model);
		if (saved) return saved;
	}
	return currentSessionModel;
}

export function inheritedThinking(effective: Model<Api> | undefined, currentThinking: ThinkingLevel): ThinkingLevel {
	return effective ? (clampThinkingLevel(effective, currentThinking) as ThinkingLevel) : currentThinking;
}
