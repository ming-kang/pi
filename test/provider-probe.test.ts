import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { PROBE_LIMITS } from "../src/extensions/provider/constants.ts";
import { type ProbeModel, probeProviderModels } from "../src/extensions/provider/probe.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(impl: (url: URL, init: RequestInit) => Promise<Response> | Response): {
	fetch: FetchFunction;
	calls: { url: URL; init: RequestInit }[];
} {
	const calls: { url: URL; init: RequestInit }[] = [];
	const fetchFn = (async (input: URL | RequestInfo | string, init?: RequestInit) => {
		const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
		const call = { url, init: init ?? {} };
		calls.push(call);
		return impl(url, call.init);
	}) as FetchFunction;
	return { fetch: fetchFn, calls };
}

describe("provider probe", () => {
	test("parses an OpenAI-style catalog, dedupes and sorts ids", async () => {
		const { fetch, calls } = mockFetch(() =>
			jsonResponse({
				data: [
					{ id: "zeta" },
					{ id: "alpha", name: "Alpha Model" },
					{ id: "alpha", name: "duplicate ignored" },
					{ id: "  " },
					{ nope: true },
					{ id: "same", name: "same" }, // name equal to id is dropped
				],
			}),
		);
		const result = await probeProviderModels({ baseUrl: "https://api.example.com/v1/", fetch });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.models).toEqual([{ id: "alpha", name: "Alpha Model" }, { id: "same" }, { id: "zeta" }]);
		// /v1 is not doubled and no duplicate slashes appear.
		expect(calls[0]!.url.toString()).toBe("https://api.example.com/v1/models");
	});

	test("keeps query parameters of the base URL", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({ baseUrl: "https://api.example.com/v1?tenant=a%20b", fetch });
		expect(calls[0]!.url.toString()).toBe("https://api.example.com/v1/models?tenant=a%20b");
	});

	test("accepts models[] and slug/display_name catalogs", async () => {
		const { fetch } = mockFetch(() =>
			jsonResponse({ models: [{ slug: "k3", display_name: "Kimi K3", context_window: 999999 }] }),
		);
		expect(await probeProviderModels({ baseUrl: "https://example.test/v1", fetch })).toEqual({
			ok: true,
			models: [{ id: "k3", name: "Kimi K3", contextWindow: 999999 }],
			truncated: false,
		});
	});

	test("uses the Anthropic catalog path and honors configured headers with explicit Authorization", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({
			baseUrl: "https://example.test/anthropic",
			api: "anthropic-messages",
			auth: { headers: { Authorization: "Bearer fixture", Accept: "text/event-stream" } },
			fetch,
		});
		expect(calls[0]!.url.pathname).toBe("/anthropic/v1/models");
		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("accept")).toBe("text/event-stream");
	});

	test("a null configured header removes a buildHeaders default", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({
			baseUrl: "https://example.test/v1",
			auth: { headers: { accept: null } },
			fetch,
		});
		expect(new Headers(calls[0]!.init.headers).get("accept")).toBeNull();
	});

	test("redacts resolved credentials from server errors", async () => {
		const key = "provider-review-private-key";
		const { fetch } = mockFetch(() => new Response(`Rejected token ${key}`, { status: 401 }));
		const result = await probeProviderModels({ baseUrl: "https://example.test/v1", auth: { apiKey: key }, fetch });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toContain(key);
			expect(result.error).toContain("[redacted]");
		}
	});

	test("marks a partial paginated catalog as truncated", async () => {
		const { fetch } = mockFetch(() => jsonResponse({ data: [{ id: "first" }], has_more: true }));
		expect(await probeProviderModels({ baseUrl: "https://example.test/v1", fetch })).toMatchObject({
			ok: true,
			truncated: true,
		});
	});

	test("sends Bearer auth unless headers override or remove it", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({
			baseUrl: "https://api.example.com",
			auth: { apiKey: "sk-1" },
			fetch,
		});
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-1");

		await probeProviderModels({
			baseUrl: "https://api.example.com",
			auth: { apiKey: "sk-1", headers: { authorization: "Token abc" } },
			fetch,
		});
		expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Token abc");

		await probeProviderModels({
			baseUrl: "https://api.example.com",
			auth: { apiKey: "sk-1", headers: { authorization: null } },
			fetch,
		});
		expect(new Headers(calls[2]!.init.headers).get("authorization")).toBeNull();
	});

	test("unconfigured auth fetches anonymously", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		const result = await probeProviderModels({ baseUrl: "https://api.example.com", fetch });
		expect(result.ok).toBe(true);
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
	});

	test("anthropic-messages uses x-api-key + version, OAuth tokens keep Bearer", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({
			baseUrl: "https://api.anthropic.com",
			auth: { apiKey: "sk-ant-api-key" },
			api: "anthropic-messages",
			fetch,
		});
		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get("x-api-key")).toBe("sk-ant-api-key");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("authorization")).toBeNull();

		await probeProviderModels({
			baseUrl: "https://api.anthropic.com",
			auth: { apiKey: "sk-ant-oat-token" },
			api: "anthropic-messages",
			fetch,
		});
		expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer sk-ant-oat-token");
	});

	test("configured headers win over protocol defaults", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({
			baseUrl: "https://api.example.com",
			auth: { apiKey: "sk-1", headers: { "X-API-Key": "custom", "anthropic-version": "2024-01-01" } },
			api: "anthropic-messages",
			fetch,
		});
		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get("x-api-key")).toBe("custom");
		expect(headers.get("anthropic-version")).toBe("2024-01-01");
	});

	test("google apis use x-goog-api-key", async () => {
		const { fetch, calls } = mockFetch(() => jsonResponse({ data: [] }));
		await probeProviderModels({
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			auth: { apiKey: "g-key" },
			api: "google-generative-ai",
			fetch,
		});
		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get("x-goog-api-key")).toBe("g-key");
		expect(headers.get("authorization")).toBeNull();
	});

	test("anthropic display_name becomes the model name", async () => {
		const { fetch } = mockFetch(() =>
			jsonResponse({ data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }] }),
		);
		const result = await probeProviderModels({
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			fetch,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.models).toEqual([{ id: "claude-opus-4-6", name: "Claude Opus 4.6" }]);
	});

	test("non-OK responses surface a bounded error body", async () => {
		const huge = "x".repeat(10_000);
		const { fetch } = mockFetch(() => new Response(huge, { status: 401 }));
		const result = await probeProviderModels({ baseUrl: "https://api.example.com", fetch });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.startsWith("HTTP 401: xxxx")).toBe(true);
		expect(result.error.length).toBeLessThan(500);
	});

	test("non-JSON and missing-data responses are distinct errors", async () => {
		const notJson = mockFetch(() => new Response("<html>no</html>", { status: 200 }));
		const a = await probeProviderModels({ baseUrl: "https://api.example.com", fetch: notJson.fetch });
		expect(a.ok).toBe(false);
		if (!a.ok) expect(a.error).toContain("not JSON");

		const noData = mockFetch(() => jsonResponse({ unexpected: [] }));
		const b = await probeProviderModels({ baseUrl: "https://api.example.com", fetch: noData.fetch });
		expect(b.ok).toBe(false);
		if (!b.ok) expect(b.error).toContain("OpenAI-style");
	});

	test("truncates catalogs beyond the cap", async () => {
		const data = Array.from({ length: 2100 }, (_, i) => ({ id: `m${i}` }));
		const { fetch } = mockFetch(() => jsonResponse({ data }));
		const result = await probeProviderModels({ baseUrl: "https://api.example.com", fetch });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.models).toHaveLength(2000);
		expect(result.truncated).toBe(true);
	});

	test("rejects URLs with credentials, fragments, or non-http protocols", async () => {
		for (const baseUrl of ["ftp://example.com", "https://user:pass@example.com", "https://example.com/v1#frag"]) {
			const result = await probeProviderModels({
				baseUrl,
				fetch: mockFetch(() => jsonResponse({ data: [] })).fetch,
			});
			expect(result.ok).toBe(false);
		}
	});

	test("an aborted outer signal cancels before the request", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await probeProviderModels({
			baseUrl: "https://api.example.com",
			signal: controller.signal,
			fetch: mockFetch(() => jsonResponse({ data: [] })).fetch,
		});
		expect(result).toEqual({ ok: false, error: "Cancelled." });
	});

	test("times out when the endpoint never answers", async () => {
		const never = mockFetch(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				}),
		);
		const result = await probeProviderModels({
			baseUrl: "https://api.example.com",
			fetch: never.fetch,
			timeoutMs: 50,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Timed out");
	});
});

// Entries trimmed from real /models responses.
const metadataCases: { name: string; entry: Record<string, unknown>; expected: ProbeModel }[] = [
	{
		name: "flat limits, a modality list, and effort levels (DeepSeek)",
		entry: {
			id: "deepseek-flash",
			object: "model",
			name: "DeepSeek-V4.1-Flash",
			context_window: 1048576,
			max_output_tokens: 393216,
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
		},
		expected: {
			id: "deepseek-flash",
			name: "DeepSeek-V4.1-Flash",
			contextWindow: 1048576,
			maxTokens: 393216,
			input: ["text", "image"],
			reasoning: true,
		},
	},
	{
		name: "input/output limits and capability objects (Anthropic)",
		entry: {
			type: "model",
			id: "claude-opus-5",
			display_name: "Claude Opus 5",
			max_input_tokens: 1000000,
			max_tokens: 128000,
			capabilities: {
				image_input: { supported: true },
				pdf_input: { supported: true },
				thinking: { supported: true, types: { adaptive: { supported: true } } },
			},
		},
		expected: {
			id: "claude-opus-5",
			name: "Claude Opus 5",
			contextWindow: 1000000,
			maxTokens: 128000,
			input: ["text", "image"],
			reasoning: true,
		},
	},
	{
		name: "explicitly unsupported capabilities keep their defaults (StepFun)",
		entry: {
			id: "step-3.5-flash",
			model_type: "大语言模型",
			max_input_tokens: 262144,
			enable_vision_input: false,
			enable_reason: true,
			reasoning_effort_support_list: ["low", "medium", "high"],
		},
		expected: { id: "step-3.5-flash", contextWindow: 262144, reasoning: true },
	},
	{
		name: "disagreeing context fields resolve to the smallest (OpenRouter)",
		entry: {
			id: "inclusionai/ling-3.0-flash-vl",
			name: "inclusionAI: Ling 3.0 Flash VL",
			context_length: 262144,
			architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
			pricing: { prompt: "0.0000001", completion: "0.0000004" },
			top_provider: { context_length: 131072, max_completion_tokens: 32768 },
			supported_parameters: ["max_tokens", "reasoning", "include_reasoning", "tools"],
		},
		expected: {
			id: "inclusionai/ling-3.0-flash-vl",
			name: "inclusionAI: Ling 3.0 Flash VL",
			contextWindow: 131072,
			maxTokens: 32768,
			input: ["text", "image"],
			reasoning: true,
		},
	},
	{
		name: "a context_window object exposes its token count (LLM7)",
		entry: {
			id: "GLM-5.3-Flash",
			context_window: { tokens: 400000, chars: null },
			modalities: { input: ["text"], output: ["text"] },
			capabilities: { vision: false, reasoning: true },
		},
		expected: { id: "GLM-5.3-Flash", contextWindow: 400000, reasoning: true },
	},
	{
		name: "nested metadata and capability tags; its max_tokens is not an output limit (DeepInfra)",
		entry: {
			id: "google/gemma-4-31B-it",
			metadata: { context_length: 262144, max_tokens: 262144, tags: ["chat", "vlm", "vision", "reasoning"] },
		},
		expected: { id: "google/gemma-4-31B-it", contextWindow: 262144, input: ["text", "image"], reasoning: true },
	},
	{
		name: "placeholders, malformed limits, and unsupported modalities are ignored",
		entry: {
			id: "placeholder",
			max_input_tokens: 0,
			max_tokens: null,
			context_length: "131072",
			max_output_tokens: 1.5,
			context_window: -1,
			modalities: { input: ["text", "audio"] },
		},
		expected: { id: "placeholder" },
	},
];

describe("provider probe metadata", () => {
	test.each(metadataCases)("$name", async ({ entry, expected }) => {
		const { fetch } = mockFetch(() => jsonResponse({ data: [entry] }));
		expect(await probeProviderModels({ baseUrl: "https://example.test/v1", fetch })).toEqual({
			ok: true,
			models: [expected],
			truncated: false,
		});
	});
});

describe("provider probe Anthropic-compatible gateways", () => {
	test("a gateway without an Anthropic catalog is retried once at its OpenAI-style root", async () => {
		const { fetch, calls } = mockFetch((url) =>
			url.pathname === "/anthropic/v1/models"
				? new Response("", { status: 404 })
				: jsonResponse({ data: [{ id: "deepseek-flash" }] }),
		);
		const result = await probeProviderModels({
			baseUrl: "https://api.example.com/anthropic",
			api: "anthropic-messages",
			auth: { apiKey: "sk-1" },
			fetch,
		});
		expect(result).toEqual({ ok: true, models: [{ id: "deepseek-flash" }], truncated: false });
		expect(calls.map((call) => call.url.href)).toEqual([
			"https://api.example.com/anthropic/v1/models",
			"https://api.example.com/v1/models",
		]);
		const retry = new Headers(calls[1]!.init.headers);
		expect(retry.get("authorization")).toBe("Bearer sk-1");
		expect(retry.get("x-api-key")).toBeNull();
	});

	test("a catalog that rejects x-api-key is retried with Bearer at the same URL", async () => {
		const { fetch, calls } = mockFetch((_url, init) =>
			new Headers(init.headers).get("authorization") === "Bearer sk-1"
				? jsonResponse({ data: [{ id: "step-3.5-flash" }] })
				: jsonResponse({ error: { message: "Incorrect API key provided" } }, 401),
		);
		const result = await probeProviderModels({
			baseUrl: "https://api.example.com/step_plan",
			api: "anthropic-messages",
			auth: { apiKey: "sk-1" },
			fetch,
		});
		expect(result.ok).toBe(true);
		expect(calls.map((call) => call.url.pathname)).toEqual(["/step_plan/v1/models", "/step_plan/v1/models"]);
	});

	test("configured Authorization and other APIs are never retried", async () => {
		const configured = mockFetch(() => new Response("", { status: 401 }));
		await probeProviderModels({
			baseUrl: "https://api.example.com/anthropic",
			api: "anthropic-messages",
			auth: { apiKey: "sk-1", headers: { Authorization: "Bearer custom" } },
			fetch: configured.fetch,
		});
		expect(configured.calls).toHaveLength(1);
		const openai = mockFetch(() => new Response("", { status: 404 }));
		await probeProviderModels({
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			auth: { apiKey: "sk-1" },
			fetch: openai.fetch,
		});
		expect(openai.calls).toHaveLength(1);
	});

	test("a retry that would repeat the first attempt is skipped", async () => {
		const { fetch, calls } = mockFetch(() => new Response("", { status: 401 }));
		await probeProviderModels({
			// Root base: the retry URL is the same and Bearer auth is already in use.
			baseUrl: "https://api.example.com",
			api: "anthropic-messages",
			auth: { apiKey: "sk-ant-oat01-fixture" },
			fetch,
		});
		expect(calls).toHaveLength(1);
	});

	test("a failed retry reports both attempts without leaking the key", async () => {
		const key = "provider-retry-private-key";
		const { fetch, calls } = mockFetch(() => new Response(`Rejected token ${key}`, { status: 401 }));
		const result = await probeProviderModels({
			baseUrl: "https://api.example.com/anthropic",
			api: "anthropic-messages",
			auth: { apiKey: key },
			fetch,
		});
		expect(calls).toHaveLength(2);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("https://api.example.com/anthropic/v1/models");
		expect(result.error).toContain("https://api.example.com/v1/models");
		expect(result.error).toContain("HTTP 401");
		expect(result.error).not.toContain(key);
	});
});

describe("provider probe pagination", () => {
	test("Anthropic catalogs follow has_more pages", async () => {
		const { fetch, calls } = mockFetch((url) =>
			url.searchParams.get("after_id") === "claude-b"
				? jsonResponse({ data: [{ id: "claude-a" }], has_more: false, first_id: "claude-a", last_id: "claude-a" })
				: jsonResponse({
						data: [{ id: "claude-c" }, { id: "claude-b" }],
						has_more: true,
						first_id: "claude-c",
						last_id: "claude-b",
					}),
		);
		const result = await probeProviderModels({
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			fetch,
		});
		expect(result).toEqual({
			ok: true,
			models: [{ id: "claude-a" }, { id: "claude-b" }, { id: "claude-c" }],
			truncated: false,
		});
		expect(calls[1]!.url.search).toBe("?after_id=claude-b&limit=1000");
	});

	test("a failed later page keeps the models already listed and stays partial", async () => {
		const { fetch, calls } = mockFetch((url) =>
			url.searchParams.get("after_id")
				? new Response("", { status: 500 })
				: jsonResponse({ data: [{ id: "a" }], has_more: true, last_id: "a" }),
		);
		expect(
			await probeProviderModels({ baseUrl: "https://api.anthropic.com", api: "anthropic-messages", fetch }),
		).toEqual({ ok: true, models: [{ id: "a" }], truncated: true });
		expect(calls).toHaveLength(2);
	});

	test("a later page in an unsupported shape keeps the models already listed and stays partial", async () => {
		const { fetch } = mockFetch((url) =>
			url.searchParams.get("after_id")
				? jsonResponse({ unexpected: true })
				: jsonResponse({ data: [{ id: "a" }], has_more: true, last_id: "a" }),
		);
		expect(
			await probeProviderModels({ baseUrl: "https://api.anthropic.com", api: "anthropic-messages", fetch }),
		).toEqual({ ok: true, models: [{ id: "a" }], truncated: true });
	});

	test("paging stops at the page cap or a repeated cursor and marks the catalog partial", async () => {
		let page = 0;
		const endless = mockFetch(() => {
			page++;
			return jsonResponse({ data: [{ id: `m${page}` }], has_more: true, last_id: `m${page}` });
		});
		const capped = await probeProviderModels({
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			fetch: endless.fetch,
		});
		expect(endless.calls).toHaveLength(PROBE_LIMITS.maxPages);
		expect(capped).toMatchObject({ ok: true, truncated: true });

		const stuck = mockFetch(() => jsonResponse({ data: [{ id: "same" }], has_more: true, last_id: "same" }));
		const repeated = await probeProviderModels({
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			fetch: stuck.fetch,
		});
		expect(stuck.calls).toHaveLength(2);
		expect(repeated).toEqual({ ok: true, models: [{ id: "same" }], truncated: true });
	});
});
