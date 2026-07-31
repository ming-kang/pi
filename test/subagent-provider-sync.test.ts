import { type Api, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { syncParentProviders } from "../src/extensions/subagent/index.ts";

function fakeRegistry(source: ModelRuntime, apiKeys: Record<string, string> = {}): ModelRegistry {
	return {
		getRegisteredProviderIds: () => source.getRegisteredProviderIds(),
		getRegisteredNativeProvider: (id: string) => source.getRegisteredNativeProvider(id),
		getRegisteredProviderConfig: (id: string) => source.getRegisteredProviderConfig(id),
		getProviderAuth: async (id: string) =>
			apiKeys[id] !== undefined ? { auth: { apiKey: apiKeys[id] } } : undefined,
	} as unknown as ModelRegistry;
}

describe("subagent parent provider sync", () => {
	it("re-syncs only what changed: unchanged providers and keys stay untouched", async () => {
		const source = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const faux = fauxProvider({ provider: `sync-source-${Date.now()}-${Math.random()}` });
		source.registerNativeProvider(faux.provider);
		await source.setRuntimeApiKey(faux.provider.id, "key-1", { allowNetwork: false });

		const target = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const registerNative = vi.spyOn(target, "registerNativeProvider");
		const setKey = vi.spyOn(target, "setRuntimeApiKey");
		const unregister = vi.spyOn(target, "unregisterProvider");
		const removeKey = vi.spyOn(target, "removeRuntimeApiKey");

		const syncedIds = new Set<string>();
		const syncedApiKeys = new Map<string, string>();
		const registryWith = (apiKeys: Record<string, string>) => fakeRegistry(source, apiKeys);

		await syncParentProviders(target, registryWith({ [faux.provider.id]: "key-1" }), syncedIds, syncedApiKeys);
		expect(registerNative).toHaveBeenCalledTimes(1);
		expect(setKey).toHaveBeenCalledTimes(1);

		// Nothing changed: neither the provider nor the key is re-applied.
		await syncParentProviders(target, registryWith({ [faux.provider.id]: "key-1" }), syncedIds, syncedApiKeys);
		expect(registerNative).toHaveBeenCalledTimes(1);
		expect(setKey).toHaveBeenCalledTimes(1);

		// A changed key re-keys without re-registering the provider.
		await syncParentProviders(target, registryWith({ [faux.provider.id]: "key-2" }), syncedIds, syncedApiKeys);
		expect(registerNative).toHaveBeenCalledTimes(1);
		expect(setKey).toHaveBeenCalledTimes(2);

		// Removal unregisters the provider and clears its runtime key.
		source.unregisterProvider(faux.provider.id);
		await syncParentProviders(target, registryWith({}), syncedIds, syncedApiKeys);
		expect(unregister).toHaveBeenCalledTimes(1);
		expect(removeKey).toHaveBeenCalledTimes(1);
	});

	it("re-registers only when an extension provider config changes", async () => {
		const source = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		source.registerProvider("sync-ext", {
			baseUrl: "https://one.test",
			apiKey: "k",
			models: [
				{
					id: "sync-m",
					name: "Sync M",
					api: "test-api" as Api,
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
			],
		});

		const target = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const register = vi.spyOn(target, "registerProvider");
		const syncedIds = new Set<string>();
		const syncedApiKeys = new Map<string, string>();
		const registry = fakeRegistry(source);

		await syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		expect(register).toHaveBeenCalledTimes(1);

		await syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		expect(register).toHaveBeenCalledTimes(1);

		// Re-registration merges, so the baseUrl override changes the config.
		source.registerProvider("sync-ext", { baseUrl: "https://two.test" });
		await syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		expect(register).toHaveBeenCalledTimes(2);
	});
});
