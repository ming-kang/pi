import { afterEach, describe, expect, it, vi } from "vitest";
import { probeRelayModels } from "../src/extensions/router/probe.ts";
import { isCurrentRouterModel, resolveProbeApiKey } from "../src/extensions/router/ui.ts";

describe("router catalog probe API key resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("resolves literal and environment-backed keys", () => {
		vi.stubEnv("ROUTER_TEST_KEY", "secret");
		expect(resolveProbeApiKey("sk-literal")).toEqual({ value: "sk-literal" });
		expect(resolveProbeApiKey("$ROUTER_TEST_KEY")).toEqual({ value: "secret" });
		expect(resolveProbeApiKey(`\${ROUTER_TEST_KEY}`)).toEqual({ value: "secret" });
	});

	it("explains unresolved or dynamic keys instead of probing anonymously", () => {
		expect(resolveProbeApiKey("$ROUTER_MISSING_KEY").error).toContain("$ROUTER_MISSING_KEY");
		expect(resolveProbeApiKey("!secret-command").error).toContain("!command");
		expect(resolveProbeApiKey(`\${A}-$B`).error).toContain("interpolation");
	});

	it("does not start a fetch with an already-aborted signal", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const controller = new AbortController();
		controller.abort();
		await expect(
			probeRelayModels({ baseUrl: "https://relay.example/v1", signal: controller.signal }),
		).resolves.toEqual({ ok: false, error: "Cancelled." });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("identifies the active model without treating another provider as active", () => {
		expect(isCurrentRouterModel({ provider: "relay", id: "gpt-5" }, "relay", "gpt-5")).toBe(true);
		expect(isCurrentRouterModel({ provider: "relay", id: "gpt-5" }, "relay", "gpt-4")).toBe(false);
		expect(isCurrentRouterModel({ provider: "other", id: "gpt-5" }, "relay", "gpt-5")).toBe(false);
		expect(isCurrentRouterModel(undefined, "relay", "gpt-5")).toBe(false);
	});
});
