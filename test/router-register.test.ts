import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { applyRouterFile, toProviderConfig } from "../src/extensions/router/register.ts";
import type { RelayConfig } from "../src/extensions/router/types.ts";

function relay(id: string): RelayConfig {
	return {
		id,
		baseUrl: `https://${id}.example/v1`,
		apiKey: "secret",
		models: [{ id: "model" }],
	};
}

function api() {
	return {
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
	} as unknown as ExtensionAPI;
}

describe("router provider registration isolation", () => {
	it("captures headers without retaining the mutable router file object", () => {
		const entry = { ...relay("alpha"), headers: { "X-Tenant": "original" } };
		const config = toProviderConfig(entry);
		entry.headers["X-Tenant"] = "edited";
		expect(config.headers).toEqual({ "X-Tenant": "original" });
		expect(toProviderConfig(relay("beta")).headers).toEqual({});
	});

	it("tracks provider ids independently for separate SDK hosts", () => {
		const first = api();
		const second = api();
		applyRouterFile(first, { version: 1, relays: [relay("alpha")] });
		applyRouterFile(second, { version: 1, relays: [relay("beta")] });

		applyRouterFile(first, { version: 1, relays: [] });
		expect(first.unregisterProvider).toHaveBeenCalledWith("alpha");
		expect(first.unregisterProvider).not.toHaveBeenCalledWith("beta");
		expect(second.unregisterProvider).not.toHaveBeenCalled();

		applyRouterFile(second, { version: 1, relays: [] });
		expect(second.unregisterProvider).toHaveBeenCalledWith("beta");
	});

	it("re-applies and removes providers cleanly on the same host", () => {
		const host = api();
		applyRouterFile(host, { version: 1, relays: [relay("alpha")] });
		applyRouterFile(host, { version: 1, relays: [relay("alpha")] });
		expect(host.registerProvider).toHaveBeenCalledTimes(2);

		applyRouterFile(host, { version: 1, relays: [] });
		expect(host.unregisterProvider).toHaveBeenCalledTimes(1);
	});
});

async function runtimeHost() {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryCodingAgentModelsStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const registry = new ModelRegistry(runtime);
	const host = {
		registerProvider: registry.registerProvider.bind(registry),
		unregisterProvider: vi.fn(registry.unregisterProvider.bind(registry)),
	} as unknown as ExtensionAPI;
	return { runtime, registry, host };
}

// The real runtime resolves auth and invokes the actual router/Responses adapter.
// Only its final HTTP boundary is replaced; no filesystem credentials or network are used.
async function requestHeaders(runtime: ModelRuntime, registry: ModelRegistry, id: string) {
	const model = registry.find(id, "model");
	if (!model) throw new Error(`Missing test model: ${id}`);
	const auth = await registry.getApiKeyAndHeaders(model);
	const requests: Request[] = [];
	const fetch: FetchFunction = async (input, init) => {
		requests.push(new Request(input, init));
		const events = [
			{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
			{
				type: "response.completed",
				response: {
					id: "resp_test",
					status: "completed",
					output: [],
					usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
				},
			},
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await runtime
		.streamSimple(
			model,
			{ messages: [{ role: "user", content: "Synthetic header regression", timestamp: 1 }] },
			{ fetch, maxRetries: 0 },
		)
		.result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(requests).toHaveLength(1);
	expect(requests[0].url).toBe(`https://${id}.example/v1/responses`);
	expect(requests[0].method).toBe("POST");
	return { headers: requests[0].headers, auth };
}

describe("router reload header snapshots through ModelRuntime", () => {
	it.each<{
		label: string;
		headers: Record<string, string> | undefined;
		authorization: string;
		tenant: string | null;
	}>([
		{ label: "omitted", headers: undefined, authorization: "Bearer new-key", tenant: null },
		{ label: "empty", headers: {}, authorization: "Bearer new-key", tenant: null },
		{
			label: "delete tenant only",
			headers: { Authorization: "Bearer old-authorization" },
			authorization: "Bearer old-authorization",
			tenant: null,
		},
		{
			label: "delete Authorization only",
			headers: { "X-Tenant": "old-tenant" },
			authorization: "Bearer new-key",
			tenant: "old-tenant",
		},
		{
			label: "replace Authorization",
			headers: { authorization: "Bearer replacement", "X-Tenant": "new-tenant" },
			authorization: "Bearer replacement",
			tenant: "new-tenant",
		},
	])("uses the current $label headers, including repeated reloads and relay isolation", async (testCase) => {
		const { runtime, registry, host } = await runtimeHost();
		const alpha: RelayConfig = {
			...relay("router-alpha"),
			apiKey: "old-key",
			headers: { Authorization: "Bearer old-authorization", "X-Tenant": "old-tenant" },
			models: [{ id: "model", headers: { "X-Model-Route": "preserved" } }],
		};
		const beta: RelayConfig = {
			...relay("router-beta"),
			apiKey: "beta-key",
			headers: { Authorization: "Bearer beta-authorization", "X-Tenant": "beta-tenant" },
		};
		applyRouterFile(host, { version: 1, relays: [alpha, beta] });
		const initial = await requestHeaders(runtime, registry, alpha.id);
		expect(initial.headers.get("authorization")).toBe("Bearer old-authorization");
		expect(initial.headers.get("x-tenant")).toBe("old-tenant");
		expect(initial.auth).toMatchObject({ ok: true, apiKey: "old-key" });

		const next = { ...alpha, apiKey: "new-key" };
		delete next.headers;
		if (testCase.headers !== undefined) next.headers = testCase.headers;
		for (let reload = 0; reload < 3; reload++) {
			applyRouterFile(host, { version: 1, relays: [next, beta] });
			const current = await requestHeaders(runtime, registry, alpha.id);
			expect(current.headers.get("authorization")).toBe(testCase.authorization);
			expect(current.headers.get("x-tenant")).toBe(testCase.tenant);
			expect(current.headers.get("x-model-route")).toBe("preserved");
			expect(current.auth).toMatchObject({ ok: true, apiKey: "new-key" });
			if (!current.auth.ok) throw new Error(current.auth.error);
			expect(current.auth.headers).toEqual({ ...testCase.headers, "X-Model-Route": "preserved" });
			const other = await requestHeaders(runtime, registry, beta.id);
			expect(other.headers.get("authorization")).toBe("Bearer beta-authorization");
			expect(other.headers.get("x-tenant")).toBe("beta-tenant");
			expect(other.headers.has("x-model-route")).toBe(false);
			expect(other.auth).toMatchObject({ ok: true, apiKey: "beta-key" });
		}
		expect(host.unregisterProvider).not.toHaveBeenCalled();
	});
});
