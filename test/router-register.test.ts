import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { applyRouterFile } from "../src/extensions/router/register.ts";
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
