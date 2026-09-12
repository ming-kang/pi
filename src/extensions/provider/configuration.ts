/** Provider defaults and draft completeness shared by the editor and persistence layer. */

import type { ModelsJsonModel, ModelsJsonProvider } from "../../core/model-config.ts";
import { builtinDefaults } from "./catalog.ts";

export function hasProviderSettings(provider: ModelsJsonProvider | undefined): boolean {
	return Boolean(
		provider &&
			(provider.baseUrl ||
				provider.apiKey ||
				provider.headers ||
				provider.compat ||
				provider.oauth ||
				provider.authHeader !== undefined ||
				provider.models?.length ||
				Object.keys(provider.modelOverrides ?? {}).length),
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
