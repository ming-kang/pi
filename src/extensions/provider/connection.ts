/** Saved provider configuration, canonical authentication, and catalog import operations. */

import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { effectiveModelSettings } from "./configuration.ts";
import { formatError, PROBE_LIMITS } from "./constants.ts";
import { type ProbeModel, type ProbeResult, probeProviderModels } from "./probe.ts";
import type { RefreshCoordinator } from "./refresh.ts";
import type { ModelsJsonStore } from "./store.ts";

export interface ProviderConnectionOptions {
	store: ModelsJsonStore;
	refresher: RefreshCoordinator;
	providerId: string;
	runtime: Pick<ModelRuntime, "getAuth" | "getProviderAuthStatus">;
}

export async function fetchProviderModels(
	options: ProviderConnectionOptions,
	signal: AbortSignal,
): Promise<ProbeResult> {
	const { store, refresher, runtime, providerId } = options;
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(PROBE_LIMITS.timeoutMs)]);
	try {
		await raceWithAbortSignal(store.flush(), deadline);
		const unsaved = store.getPendingError(providerId);
		if (unsaved) return { ok: false, error: `Save the provider changes before fetching: ${unsaved}` };
		const provider = store.getProvider(providerId);
		const settings = effectiveModelSettings(providerId, provider);
		if (!settings.baseUrl) return { ok: false, error: "Set a baseUrl under API Auth first." };
		const sync = await refresher.refreshNow(providerId, deadline);
		deadline.throwIfAborted();
		if (!sync.ok) return { ok: false, error: `The provider did not reload: ${sync.errors.join("; ")}` };
		const resolved = await raceWithAbortSignal(runtime.getAuth(providerId, { signal: deadline }), deadline);
		const configured =
			provider?.apiKey !== undefined ||
			provider?.authHeader === true ||
			Object.keys(provider?.headers ?? {}).length > 0 ||
			runtime.getProviderAuthStatus(providerId).configured;
		if (!resolved && configured) {
			return {
				ok: false,
				error: "Configured credentials or headers did not resolve; check the provider authentication.",
			};
		}
		const result = await probeProviderModels({
			baseUrl: resolved?.auth.baseUrl ?? settings.baseUrl,
			auth: resolved?.auth,
			api: settings.api,
			signal: deadline,
		});
		deadline.throwIfAborted();
		return result;
	} catch (error) {
		if (deadline.aborted) {
			return {
				ok: false,
				error: signal.aborted ? "Cancelled." : "Timed out while preparing or fetching the model catalog.",
			};
		}
		return { ok: false, error: formatError(error) };
	}
}

export async function importProviderModels(
	options: ProviderConnectionOptions,
	models: readonly ProbeModel[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const { store, refresher, providerId } = options;
	await raceWithAbortSignal(store.flush(), signal);
	const unsaved = store.getPendingError(providerId);
	if (unsaved) return unsaved;
	const settings = effectiveModelSettings(providerId, store.getProvider(providerId));
	if (!settings.api || !settings.baseUrl) return "Set baseUrl and API Type under API Auth before importing models.";
	const existing = new Set(store.getModels(providerId).map((model) => model.id));
	const fresh = models.filter((model) => {
		if (existing.has(model.id)) return false;
		existing.add(model.id);
		return true;
	});
	if (fresh.length === 0) return undefined;
	signal.throwIfAborted();
	store.batch(() => {
		for (const model of fresh)
			store.addModel(providerId, model.name ? { id: model.id, name: model.name } : { id: model.id });
	});
	refresher.touch(providerId);
	// These edits were confirmed. Finish the write even if the originating pane closes.
	await store.flush();
	const saveError = store.getPendingError(providerId);
	if (saveError) return saveError;
	const outcome = await refresher.refreshNow(providerId, signal);
	if (!outcome.ok) return `Models were saved, but refresh failed: ${outcome.errors.join("; ")}`;
	return undefined;
}
