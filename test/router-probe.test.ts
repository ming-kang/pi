import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/extensions/router/constants.ts";
import { CODEX_ORIGINATOR, CODEX_VERSION, getCodexUserAgent } from "../src/extensions/router/identity.ts";
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

	it.each(["openai", "codex"] as const)(
		"cancels and rejects an oversized successful %s catalog body",
		async (catalog) => {
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
			await expect(probeRelayModels({ baseUrl: "https://relay.example/v1", catalog })).resolves.toEqual({
				ok: false,
				error: `Response exceeds ${DEFAULTS.probeBodyBytes} bytes.`,
			});
			expect(cancelled).toHaveBeenCalledOnce();
		},
	);

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

describe("router catalog formats and transport", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["openai", "codex"] as const)(
		"uses JSON GET with Codex identity for %s management probes",
		async (catalog) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValue(Response.json(catalog === "codex" ? { models: [] } : { data: [] }));
			await expect(
				probeRelayModels({
					baseUrl: "https://relay.example/prefix/v1///?tenant=a%2Fb&other=hello%20world~",
					catalog,
					apiKey: "resolved-secret",
					headers: {
						"X-Tenant": "resolved-tenant",
						"X-Removed": null,
						Authorization: "stale",
						"x-pi-test": "strip",
					},
					fetch,
				}),
			).resolves.toEqual({ ok: true, models: [], truncated: false });
			const [url, init] = fetch.mock.calls[0];
			expect(String(url)).toBe(
				`https://relay.example/prefix/v1/models?tenant=a%2Fb&other=hello%20world~${catalog === "codex" ? `&client_version=${CODEX_VERSION}` : ""}`,
			);
			expect(init?.method).toBe("GET");
			const headers = new Headers(init?.headers);
			expect(headers.get("user-agent")).toBe(getCodexUserAgent());
			expect(headers.get("originator")).toBe(CODEX_ORIGINATOR);
			expect(headers.get("accept")).toBe("application/json");
			expect(headers.get("authorization")).toBe("stale");
			expect(headers.get("x-tenant")).toBe("resolved-tenant");
			expect(headers.has("x-removed")).toBe(false);
			expect(headers.has("x-pi-test")).toBe(false);
			headers.forEach((value) => {
				expect(value).not.toBe("null");
			});
		},
	);

	it("does not resurrect a configured null Authorization over the default Bearer key", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ data: [] }));
		await probeRelayModels({
			baseUrl: "https://relay.example/v1",
			apiKey: "synthetic",
			headers: { AUTHORIZATION: null },
			fetch,
		});
		const headers = new Headers(fetch.mock.calls[0][1]?.headers);
		expect(headers.has("authorization")).toBe(false);
		expect(headers.has("content-type")).toBe(false);
	});

	it("uses the release's whole Cargo version and replaces an existing client_version", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ models: [] }));
		await probeRelayModels({
			baseUrl: "https://relay.example/backend-api/codex?client_version=old&tenant=1",
			catalog: "codex",
			fetch,
		});
		expect(String(fetch.mock.calls[0][0])).toBe(
			"https://relay.example/backend-api/codex/models?client_version=0.153.4&tenant=1",
		);
	});

	it("imports only recognized Codex capabilities, never remote transport or output defaults", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json({
				models: [
					{
						slug: " gpt-test ",
						display_name: " GPT Test ",
						context_window: 300000,
						max_context_window: 272000,
						supported_reasoning_levels: [
							{ effort: "none" },
							{ effort: "minimal" },
							{ effort: "high" },
							{ effort: "alien" },
						],
						supports_reasoning_summary_parameter: true,
						default_reasoning_summary: "concise",
						support_verbosity: true,
						default_verbosity: "low",
						input_modalities: ["text", "image", "audio"],
						maxTokens: 5000,
						max_output_tokens: 9000,
						headers: { Evil: "yes" },
						apiKey: "bad",
						baseURL: "https://evil.example",
						cost: { input: 0 },
					},
				],
			}),
		);
		await expect(probeRelayModels({ baseUrl: "https://relay.example", catalog: "codex", fetch })).resolves.toEqual({
			ok: true,
			truncated: false,
			models: [
				{
					id: "gpt-test",
					name: "GPT Test",
					metadata: {
						contextWindow: 272000,
						reasoning: true,
						input: ["text", "image"],
						thinkingLevelMap: {
							off: "none",
							minimal: "minimal",
							low: null,
							medium: null,
							high: "high",
							xhigh: null,
							max: null,
						},
						codex: { reasoningSummary: "concise", verbosity: "low" },
					},
				},
			],
		});
	});

	it("maps all seven recognized efforts without inventing new levels", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json({
				models: [
					{
						slug: "a",
						supported_reasoning_levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "future"],
					},
				],
			}),
		);
		const result = await probeRelayModels({ baseUrl: "https://relay.example", catalog: "codex", fetch });
		expect(result.ok && result.models[0].metadata?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	});

	it("preserves absent metadata, filters invalid entries, and honors explicit unsupported capabilities", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			Response.json({
				models: [
					null,
					{ id: "wrong" },
					{ slug: " " },
					{
						slug: "z",
						display_name: "z",
						context_window: -1,
						max_context_window: 99999,
						input_modalities: ["image"],
						default_verbosity: "high",
					},
					{
						slug: "a",
						supported_reasoning_levels: [],
						supports_reasoning_summary_parameter: false,
						default_reasoning_summary: "auto",
						support_verbosity: false,
					},
					{ slug: "z", display_name: "duplicate" },
				],
			}),
		);
		await expect(probeRelayModels({ baseUrl: "https://relay.example", catalog: "codex", fetch })).resolves.toEqual({
			ok: true,
			truncated: false,
			models: [
				{
					id: "a",
					metadata: {
						reasoning: false,
						thinkingLevelMap: {
							off: null,
							minimal: null,
							low: null,
							medium: null,
							high: null,
							xhigh: null,
							max: null,
						},
						codex: { reasoningSummary: null, verbosity: null },
					},
				},
				{ id: "z" },
			],
		});
	});

	it.each([0, -1, 1.5, "272000", null, Number.MAX_SAFE_INTEGER + 1])("ignores invalid context %s", async (context) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json({ models: [{ slug: "a", context_window: context }] }));
		const result = await probeRelayModels({ baseUrl: "https://relay.example", catalog: "codex", fetch });
		expect(result.ok && result.models).toEqual([{ id: "a" }]);
	});

	it.each(["openai", "codex"] as const)("rejects the wrong %s envelope with actionable errors", async (catalog) => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json(catalog === "codex" ? { data: [] } : { models: [] }));
		const result = await probeRelayModels({ baseUrl: "https://relay.example", catalog, fetch });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain("Check the base URL and catalog setting");
	});

	it.each(["openai", "codex"] as const)("bounds %s catalogs to 2000 unique models", async (catalog) => {
		const entries = Array.from({ length: 2002 }, (_, n) => ({ id: `m${n}`, slug: `m${n}` }));
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json(catalog === "codex" ? { models: entries } : { data: entries }));
		const result = await probeRelayModels({ baseUrl: "https://relay.example", catalog, fetch });
		expect(result.ok && result.truncated).toBe(true);
		expect(result.ok && result.models.length).toBe(2000);
	});

	it.each([
		"https://user:password@relay.example/v1",
		"https://relay.example/v1#fragment",
		"file:///tmp/models",
		"invalid",
	])("rejects unsafe URL %s before fetch", async (baseUrl) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		expect((await probeRelayModels({ baseUrl, fetch })).ok).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("retains timeout and in-flight cancellation", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		await expect(probeRelayModels({ baseUrl: "https://relay.example", fetch, timeoutMs: 5 })).resolves.toEqual({
			ok: false,
			error: "Timed out after 5ms.",
		});
		const controller = new AbortController();
		const pending = probeRelayModels({ baseUrl: "https://relay.example", fetch, signal: controller.signal });
		controller.abort();
		await expect(pending).resolves.toEqual({ ok: false, error: "Cancelled." });
	});
});
