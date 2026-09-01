import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/extensions/router/constants.ts";
import { probeRelayModels } from "../src/extensions/router/probe.ts";
import { isCurrentRouterModel, resolveProbeApiKey } from "../src/extensions/router/ui.ts";

describe("router catalog probe API key resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
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

	it("cancels and rejects an oversized successful catalog body", async () => {
		const cancelled = vi.fn();
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(DEFAULTS.probeBodyBytes + 1));
						},
						cancel: cancelled,
					}),
					{ status: 200 },
				),
		);
		await expect(probeRelayModels({ baseUrl: "https://relay.example/v1" })).resolves.toEqual({
			ok: false,
			error: `Response exceeds ${DEFAULTS.probeBodyBytes} bytes.`,
		});
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it("bounds non-OK relay bodies before formatting the probe error", async () => {
		vi.stubGlobal("fetch", async () => new Response("x".repeat(10_000), { status: 502 }));
		const result = await probeRelayModels({ baseUrl: "https://relay.example/v1" });
		expect(result).toEqual({ ok: false, error: `HTTP 502: ${"x".repeat(400)}` });
	});

	it("parses, deduplicates, and sorts a valid OpenAI-style catalog", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "z-model", name: "Zulu" },
							{ id: "a-model", name: "a-model" },
							{ id: "z-model", name: "Duplicate" },
							{ bad: true },
						],
					}),
				),
		);
		await expect(probeRelayModels({ baseUrl: "https://relay.example/v1" })).resolves.toEqual({
			ok: true,
			models: [{ id: "a-model" }, { id: "z-model", name: "Zulu" }],
			truncated: false,
		});
	});

	it("identifies the active model without treating another provider as active", () => {
		expect(isCurrentRouterModel({ provider: "relay", id: "gpt-5" }, "relay", "gpt-5")).toBe(true);
		expect(isCurrentRouterModel({ provider: "relay", id: "gpt-5" }, "relay", "gpt-4")).toBe(false);
		expect(isCurrentRouterModel({ provider: "other", id: "gpt-5" }, "relay", "gpt-5")).toBe(false);
		expect(isCurrentRouterModel(undefined, "relay", "gpt-5")).toBe(false);
	});
});
