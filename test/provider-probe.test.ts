import type { FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { probeProviderModels } from "../src/extensions/provider/probe.ts";

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

		const noData = mockFetch(() => jsonResponse({ models: [] }));
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
