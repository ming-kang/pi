import { describe, expect, it, vi } from "vitest";
import { runWebSearch } from "../src/extensions/search/web.ts";
import { fetchWebSearch } from "../src/extensions/search/web-client.ts";

const KEY = "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln";

function jsonFetch(body: unknown, status = 200) {
	return vi.fn(
		async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
	);
}

describe("search web backend", () => {
	it("parses results, normalizes aliases, and flags truncation", async () => {
		const fetcher = jsonFetch({
			results: [
				{
					webTitle: "Docs",
					sourceUrl: "https://example.com/docs",
					text: "A snippet.",
					date: "2026-09-08T00:00:00Z",
				},
				{ title: "Second", link: "https://example.com/2", summary: "Another." },
				{ title: "Third", link: "https://example.com/3", summary: "Dropped by limit." },
			],
		});
		const out = await fetchWebSearch(KEY, "query", 2, undefined, fetcher as unknown as typeof fetch);
		expect(out.items).toHaveLength(2);
		expect(out.items[0]).toMatchObject({ url: "https://example.com/docs", title: "Docs", snippet: "A snippet." });
		expect(out.items[0].publishedAt).toBe("2026-09-08");
		expect(out.truncated).toBe(true);
	});

	it("drops unsafe urls (non-http schemes, embedded credentials)", async () => {
		const fetcher = jsonFetch({
			results: [
				{ title: "ok", url: "http://example.com/a", snippet: "" },
				{ title: "ftp", url: "ftp://example.com/b", snippet: "" },
				{ title: "user", url: "https://user:pw@example.com/c", snippet: "" },
				{ title: "junk", url: "not-a-url", snippet: "" },
			],
		});
		const out = await fetchWebSearch(KEY, "q", 10, undefined, fetcher as unknown as typeof fetch);
		expect(out.items.map((i) => i.url)).toEqual(["http://example.com/a"]);
		expect(out.truncated).toBe(false);
	});

	it("fails over to the second host after a 401", async () => {
		const hosts: string[] = [];
		const fetcher = vi.fn(async (url: string) => {
			hosts.push(String(url));
			if (hosts.length === 1) return new Response("", { status: 401 });
			return jsonFetch({ results: [{ title: "ok", url: "https://example.com/a", snippet: "" }] })();
		});
		const out = await fetchWebSearch(KEY, "q", 5, undefined, fetcher as unknown as typeof fetch);
		expect(hosts).toHaveLength(2);
		expect(hosts[0]).toContain("server.codeium.com");
		expect(hosts[1]).toContain("server.self-serve.windsurf.com");
		expect(out.items).toHaveLength(1);
	});

	it("raises AUTH_ERROR when every host rejects the key", async () => {
		const fetcher = vi.fn(async () => new Response("", { status: 403 }));
		await expect(fetchWebSearch(KEY, "q", 5, undefined, fetcher as unknown as typeof fetch)).rejects.toMatchObject({
			code: "AUTH_ERROR",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("redacts the key out of the raw response before parsing", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ results: [{ title: "leak", url: "https://example.com/x", snippet: `token ${KEY}` }] }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const out = await fetchWebSearch(KEY, "q", 5, undefined, fetcher as unknown as typeof fetch);
		expect(out.items[0].snippet).toBe("token [redacted]");
	});

	it("clamps the result limit to 1..10", async () => {
		const fetcher = jsonFetch({ results: [] });
		await fetchWebSearch(KEY, "q", 99, undefined, fetcher as unknown as typeof fetch);
		const body = JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(body.limit).toBe(10);
	});
});

describe("search web tool output", () => {
	it("formats a numbered result envelope", async () => {
		const fetcher = jsonFetch({
			results: [
				{ title: "Docs", url: "https://example.com/docs", snippet: "Read  the  docs.", date: "2026-09-08" },
				{ title: "Blog", url: "https://example.com/blog", snippet: "A post." },
			],
		});
		vi.stubGlobal("fetch", fetcher);
		try {
			const { text, details } = await runWebSearch({ query: "some query" }, KEY);
			expect(details.status).toBe("success");
			expect(text).toContain('Web search: "some query" — 2 result(s) via Devin');
			expect(text).toContain("1. Docs");
			expect(text).toContain("   https://example.com/docs  [2026-09-08]");
			expect(text).toContain("   Read the docs.");
			expect(text).toContain("2. Blog");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("rejects an empty query without calling the backend", async () => {
		const fetcher = jsonFetch({ results: [] });
		vi.stubGlobal("fetch", fetcher);
		try {
			const { text, details } = await runWebSearch({ query: "   " }, KEY);
			expect(details.status).toBe("error");
			expect(text).toBe("Error: query is required.");
			expect(fetcher).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("maps AUTH_ERROR to a re-authentication hint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 403 })),
		);
		try {
			const { text, details } = await runWebSearch({ query: "q" }, KEY);
			expect(details.status).toBe("error");
			expect(text).toContain("/search");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("maps RATE_LIMITED to a retry hint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 429 })),
		);
		try {
			const { text } = await runWebSearch({ query: "q" }, KEY);
			expect(text).toContain("rate-limited");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
