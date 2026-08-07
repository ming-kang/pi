import { type Api, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry, ProviderConfigInput } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { syncParentProviders } from "../src/extensions/subagent/index.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

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
		// pi-ai 0.84 AuthOperationOptions carries only signal; setRuntimeApiKey's
		// credential sync hardcodes allowNetwork: false, so the test stays offline.
		await source.setRuntimeApiKey(faux.provider.id, "key-1");

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
		const firstStream = vi.fn() as unknown as NonNullable<ProviderConfigInput["streamSimple"]>;
		const sharedCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		source.registerProvider("sync-ext", {
			baseUrl: "https://one.test",
			apiKey: "k",
			api: "test-api" as Api,
			streamSimple: firstStream,
			models: [
				{
					id: "sync-m",
					name: "Sync M",
					api: "test-api" as Api,
					reasoning: true,
					input: ["text"],
					cost: sharedCost,
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
				{
					id: "sync-m-2",
					name: "Sync M 2",
					api: "test-api" as Api,
					reasoning: true,
					input: ["text"],
					cost: sharedCost,
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

		// Function-valued hooks are behavior, even though JSON serialization
		// would omit them from an otherwise unchanged config.
		const secondStream = vi.fn() as unknown as NonNullable<ProviderConfigInput["streamSimple"]>;
		source.registerProvider("sync-ext", { api: "test-api" as Api, streamSimple: secondStream });
		await syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		expect(register).toHaveBeenCalledTimes(3);
		expect(target.getRegisteredProviderConfig("sync-ext")?.streamSimple).toBe(secondStream);

		// Equivalent object graphs compare structurally even when one side
		// shares a nested object and the other duplicates it.
		source.registerProvider("sync-ext", {
			baseUrl: "https://two.test",
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
				{
					id: "sync-m-2",
					name: "Sync M 2",
					api: "test-api" as Api,
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
			],
		});
		await syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		expect(register).toHaveBeenCalledTimes(3);
	});

	it("serializes concurrent syncs so the latest provider key wins", async () => {
		const source = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const faux = fauxProvider({ provider: `sync-concurrent-${Date.now()}-${Math.random()}` });
		source.registerNativeProvider(faux.provider);
		const target = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const setKey = vi.spyOn(target, "setRuntimeApiKey");
		const firstStarted = deferred();
		const releaseFirst = deferred();
		let apiKey = "key-old";
		let authCalls = 0;
		const registry = {
			getRegisteredProviderIds: () => source.getRegisteredProviderIds(),
			getRegisteredNativeProvider: (id: string) => source.getRegisteredNativeProvider(id),
			getRegisteredProviderConfig: (id: string) => source.getRegisteredProviderConfig(id),
			getProviderAuth: async () => {
				const observedKey = apiKey;
				authCalls++;
				if (authCalls === 1) {
					firstStarted.resolve();
					await releaseFirst.promise;
				}
				return { auth: { apiKey: observedKey } };
			},
		} as unknown as ModelRegistry;
		const syncedIds = new Set<string>();
		const syncedApiKeys = new Map<string, string>();

		const first = syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		await firstStarted.promise;
		apiKey = "key-new";
		const second = syncParentProviders(target, registry, syncedIds, syncedApiKeys);
		await Promise.resolve();
		expect(authCalls).toBe(1);

		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(setKey.mock.calls.map((call) => call[1])).toEqual(["key-old", "key-new"]);
		expect(syncedApiKeys.get(faux.provider.id)).toBe("key-new");
	});

	it("retains cleanup tracking when auth lookup interrupts a sync", async () => {
		const source = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const faux = fauxProvider({ provider: `sync-failure-${Date.now()}-${Math.random()}` });
		source.registerNativeProvider(faux.provider);
		const target = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const unregister = vi.spyOn(target, "unregisterProvider");
		const syncedIds = new Set<string>();
		const syncedApiKeys = new Map<string, string>();
		const failingRegistry = {
			...fakeRegistry(source),
			getProviderAuth: async () => {
				throw new Error("auth unavailable");
			},
		} as unknown as ModelRegistry;

		await expect(syncParentProviders(target, failingRegistry, syncedIds, syncedApiKeys)).rejects.toThrow(
			"auth unavailable",
		);
		expect(syncedIds.has(faux.provider.id)).toBe(true);

		source.unregisterProvider(faux.provider.id);
		await syncParentProviders(target, fakeRegistry(source), syncedIds, syncedApiKeys);
		expect(unregister).toHaveBeenCalledTimes(1);
		expect(target.getRegisteredNativeProvider(faux.provider.id)).toBeUndefined();
	});
});
