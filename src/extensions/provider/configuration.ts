/** Provider defaults and draft completeness shared by the editor and persistence layer. */

import type { ModelsJsonModel, ModelsJsonProvider } from "../../core/model-config.ts";
import { builtinDefaults, isBuiltinProviderId } from "./catalog.ts";

/**
 * Whether a provider entry is worth writing to models.json. Any key on a
 * built-in's entry customizes a working provider; a new custom provider waits
 * until it can reach a request, since an API type or name alone cannot.
 */
export function hasProviderSettings(providerId: string, provider: ModelsJsonProvider | undefined): boolean {
	if (!provider) return false;
	if (isBuiltinProviderId(providerId)) return Object.keys(provider).length > 0;
	return Boolean(
		provider.baseUrl ||
			provider.apiKey ||
			provider.headers ||
			provider.compat ||
			provider.oauth ||
			provider.authHeader !== undefined ||
			provider.models?.length ||
			Object.keys(provider.modelOverrides ?? {}).length,
	);
}

export function effectiveModelSettings(
	providerId: string,
	provider: ModelsJsonProvider | undefined,
	model: Partial<ModelsJsonModel> = {},
): { api?: string; baseUrl?: string } {
	const fallback = builtinDefaults(providerId, model.id, model.api ?? provider?.api);
	return {
		api: model.api ?? provider?.api ?? fallback.api,
		baseUrl: model.baseUrl ?? provider?.baseUrl ?? fallback.baseUrl,
	};
}
