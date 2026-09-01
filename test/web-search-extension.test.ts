import { setKeybindings } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { configuredEngine, resolveSearchCredentials } from "../src/extensions/web-search/auth.ts";
import {
	getWebSearchPromptGuidelines,
	WEB_SEARCH_DESCRIPTION,
	WEB_SEARCH_PROMPT_SNIPPET,
} from "../src/extensions/web-search/constants.ts";
import { executeWebSearch } from "../src/extensions/web-search/execute.ts";
import { formatSearchOutput } from "../src/extensions/web-search/format.ts";
import { renderWebSearchCall, renderWebSearchResult } from "../src/extensions/web-search/render.ts";
import { fuseSearchHits, normalizeUrl } from "../src/extensions/web-search/results.ts";
import { normalizeWebSearchParams } from "../src/extensions/web-search/schema.ts";
import type { ProviderSearchResult, WebSearchHit } from "../src/extensions/web-search/types.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

let usedColors: string[] = [];
const theme = {
	fg: (color: string, text: string) => {
		usedColors.push(color);
		return text;
	},
	bold: (text: string) => text,
} as unknown as Theme;

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	usedColors = [];
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.unstubAllGlobals());

describe("web_search tool metadata", () => {
	test("keeps the snippet concise and the description provider-facing", () => {
		expect(WEB_SEARCH_PROMPT_SNIPPET).toBe("Search the live web for current information");
		expect(WEB_SEARCH_DESCRIPTION).toContain("MiniMax and DeepSeek");
		expect(WEB_SEARCH_DESCRIPTION).toContain("partial provider failures");
		expect(WEB_SEARCH_DESCRIPTION).not.toContain("allowed_domains");
	});

	test("keeps routing guidance tool-scoped and citation requirements result-scoped", () => {
		const guidelines = getWebSearchPromptGuidelines().join("\n");
		expect(guidelines).toContain("Use `web_search`");
		expect(guidelines).toContain("When using `web_search`");
		expect(guidelines).toMatch(/current date \(\d{4}-\d{2}\)/);
		expect(guidelines).not.toContain("IMPORTANT");
		expect(guidelines).not.toContain("Sources:");
		expect(guidelines).not.toContain("cite");
	});
});

describe("normalizeWebSearchParams", () => {
	test("normalizes plain string query", () => {
		expect(normalizeWebSearchParams("  react 19  ")).toEqual({ query: "react 19" });
	});

	test("normalizes aliased fields (q, search_query)", () => {
		expect(normalizeWebSearchParams({ q: "typescript 5.5" }).query).toBe("typescript 5.5");
		expect(normalizeWebSearchParams({ search_query: "bun 1.1" }).query).toBe("bun 1.1");
	});

	test("ignores removed domain-filter fields in legacy arguments", () => {
		expect(
			normalizeWebSearchParams({
				query: "nextjs",
				allowed_domains: ["nextjs.org"],
				blocked_domains: ["spam.com"],
			}),
		).toEqual({ query: "nextjs" });
	});
});

describe("resolveSearchCredentials", () => {
	const SEARCH_ENV_VARS = ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_API_HOST", "DEEPSEEK_API_KEY"];

	let savedEnv: Record<string, string | undefined>;
	let tempDir: string;
	let missingAuthPath: string;

	function stubModelRuntime(keys: Record<string, string>): ModelRuntime {
		return {
			getAuth: async (providerId: string) => {
				const key = keys[providerId];
				return key ? { auth: { apiKey: key } } : undefined;
			},
		} as unknown as ModelRuntime;
	}

	beforeEach(() => {
		savedEnv = {};
		for (const name of SEARCH_ENV_VARS) {
			savedEnv[name] = process.env[name];
			delete process.env[name];
		}
		tempDir = mkdtempSync(join(tmpdir(), "web-search-auth-"));
		missingAuthPath = join(tempDir, "missing-auth.json");
	});

	afterEach(() => {
		for (const name of SEARCH_ENV_VARS) {
			if (savedEnv[name] === undefined) delete process.env[name];
			else process.env[name] = savedEnv[name];
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("resolves dual mode through the runtime auth chain", async () => {
		const runtime = stubModelRuntime({ "minimax-cn": "mm-key", deepseek: "ds-key" });
		const creds = await resolveSearchCredentials(runtime, missingAuthPath);
		expect(configuredEngine(creds)).toBe("dual");
		expect(creds.minimax).toEqual({ key: "mm-key", host: "https://api.minimaxi.com" });
		expect(creds.deepseek).toEqual({ key: "ds-key" });
	});

	test("resolves credentials even when getProviderAuthStatus reports unconfigured", async () => {
		// Regression: AuthStatus objects are always truthy and carry no key —
		// credential resolution must go through getAuth, not the status probe.
		const runtime = {
			getAuth: async (providerId: string) =>
				providerId === "deepseek" ? { auth: { apiKey: "ds-key" } } : undefined,
			getProviderAuthStatus: () => ({ configured: false }),
		} as unknown as ModelRuntime;
		const creds = await resolveSearchCredentials(runtime, missingAuthPath);
		expect(configuredEngine(creds)).toBe("deepseek");
		expect(creds.minimax).toBeUndefined();
		expect(creds.deepseek).toEqual({ key: "ds-key" });
	});

	test("falls back to auth.json when no runtime is available", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ "minimax-cn": { type: "api_key", key: "mm-file-key" } }));
		const creds = await resolveSearchCredentials(undefined, authPath);
		expect(configuredEngine(creds)).toBe("minimax");
		expect(creds.minimax).toEqual({ key: "mm-file-key", host: "https://api.minimaxi.com" });
		expect(creds.deepseek).toBeUndefined();
	});

	test("falls back to environment variables when the runtime has nothing", async () => {
		process.env.MINIMAX_API_KEY = "mm-env-key";
		process.env.MINIMAX_API_HOST = "https://minimax.example.com/";
		process.env.DEEPSEEK_API_KEY = "ds-env-key";
		const creds = await resolveSearchCredentials(stubModelRuntime({}), missingAuthPath);
		expect(configuredEngine(creds)).toBe("dual");
		expect(creds.minimax).toEqual({ key: "mm-env-key", host: "https://minimax.example.com/" });
		expect(creds.deepseek).toEqual({ key: "ds-env-key" });
	});

	test("survives getAuth failures and reports none when nothing is configured", async () => {
		const runtime = {
			getAuth: async () => {
				throw new Error("unknown provider");
			},
		} as unknown as ModelRuntime;
		const creds = await resolveSearchCredentials(runtime, missingAuthPath);
		expect(configuredEngine(creds)).toBe("none");
		expect(creds.minimax).toBeUndefined();
		expect(creds.deepseek).toBeUndefined();
	});
});

describe("normalizeUrl", () => {
	test("strips tracking parameters and fragments", () => {
		const raw = "https://example.com/page?utm_source=twitter&utm_medium=social&ref=blog#section1";
		expect(normalizeUrl(raw)).toBe("https://example.com/page");
	});

	test("preserves non-tracking query parameters, including trailing slashes in values", () => {
		expect(normalizeUrl("https://example.com/search?q=hello&utm_source=test")).toBe(
			"https://example.com/search?q=hello",
		);
		expect(normalizeUrl("https://example.com/search?q=foo/")).toBe("https://example.com/search?q=foo/");
	});

	test("strips trailing slashes from the path even when a query is present", () => {
		expect(normalizeUrl("https://example.com/docs/")).toBe("https://example.com/docs");
		expect(normalizeUrl("https://example.com/docs/?tab=1")).toBe("https://example.com/docs?tab=1");
		expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
	});
});

describe("fuseSearchHits", () => {
	test("deduplicates overlapping URLs and ranks dual-verified hits first", () => {
		const provider1: ProviderSearchResult = {
			source: "MiniMax",
			hits: [
				{
					title: "React 19 Official",
					url: "https://react.dev/blog/react-19?utm_source=mm",
					snippet: "Official React 19 announcement.",
					sources: ["MiniMax"],
				},
				{
					title: "MiniMax Only Blog",
					url: "https://blog.minimax.com/post",
					snippet: "MiniMax snippet",
					sources: ["MiniMax"],
				},
			],
		};

		const provider2: ProviderSearchResult = {
			source: "DeepSeek",
			hits: [
				{
					title: "React 19 Release",
					url: "https://react.dev/blog/react-19#heading",
					snippet: "DeepSeek longer snippet with more detailed context.",
					sources: ["DeepSeek"],
				},
				{
					title: "DeepSeek Only Article",
					url: "https://dev.to/deepseek/post",
					snippet: "DeepSeek snippet",
					sources: ["DeepSeek"],
				},
			],
			synthesisText: "Key takeaways about React 19...",
		};

		const fused = fuseSearchHits([provider1, provider2]);

		expect(fused.hits).toHaveLength(3);
		// First hit should be the dual-verified one
		expect(fused.hits[0].url).toBe("https://react.dev/blog/react-19");
		expect(fused.hits[0].sources).toEqual(["MiniMax", "DeepSeek"]);
		// Prefers longer snippet
		expect(fused.hits[0].snippet).toBe("DeepSeek longer snippet with more detailed context.");
		expect(fused.deepseekSynthesis).toBe("Key takeaways about React 19...");
	});
	test("includes high-ranked unique results from both providers", () => {
		const provider = (source: "MiniMax" | "DeepSeek", host: string): ProviderSearchResult => ({
			source,
			hits: Array.from({ length: 12 }, (_, index) => ({
				title: `${source} ${index}`,
				url: `https://${host}/${index}`,
				sources: [source],
			})),
		});
		const fused = fuseSearchHits([provider("MiniMax", "minimax.test"), provider("DeepSeek", "deepseek.test")]);
		const sources = new Set(fused.hits.flatMap((hit) => hit.sources));
		expect(fused.hits).toHaveLength(12);
		expect(sources).toEqual(new Set(["MiniMax", "DeepSeek"]));
	});

	test("produces the same ranking regardless of provider input order", () => {
		const minimax: ProviderSearchResult = {
			source: "MiniMax",
			hits: [
				{ title: "M1", url: "https://m.test/1", sources: ["MiniMax"] },
				{ title: "M2", url: "https://m.test/2", sources: ["MiniMax"] },
			],
		};
		const deepseek: ProviderSearchResult = {
			source: "DeepSeek",
			hits: [
				{ title: "D1", url: "https://d.test/1", sources: ["DeepSeek"] },
				{ title: "D2", url: "https://d.test/2", sources: ["DeepSeek"] },
			],
		};
		expect(fuseSearchHits([minimax, deepseek]).hits.map((hit) => hit.url)).toEqual(
			fuseSearchHits([deepseek, minimax]).hits.map((hit) => hit.url),
		);
	});

	test("upgrades a URL fallback title when another provider has a descriptive title", () => {
		const fused = fuseSearchHits([
			{
				source: "MiniMax",
				hits: [{ title: "https://example.com/docs", url: "https://example.com/docs", sources: ["MiniMax"] }],
			},
			{
				source: "DeepSeek",
				hits: [{ title: "Example documentation", url: "https://example.com/docs/", sources: ["DeepSeek"] }],
			},
		]);
		expect(fused.hits[0].title).toBe("Example documentation");
	});

	test("caps related searches at 8 entries", () => {
		const fused = fuseSearchHits([
			{
				source: "MiniMax",
				hits: [],
				relatedSearches: Array.from({ length: 20 }, (_, i) => `related ${i}`),
			},
		]);
		expect(fused.relatedSearches).toHaveLength(8);
	});
});

describe("executeWebSearch", () => {
	test("propagates caller cancellation instead of returning a tool error", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			executeWebSearch(
				{ query: "current release" },
				{ minimax: { key: "key", host: "https://example.invalid" } },
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	test("propagates cancellation after provider requests have started", async () => {
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		vi.stubGlobal(
			"fetch",
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					markStarted?.();
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);

		const execution = executeWebSearch(
			{ query: "current release" },
			{ minimax: { key: "key", host: "https://example.test" } },
			controller.signal,
		);
		await started;
		controller.abort();
		await expect(execution).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("formatSearchOutput", () => {
	test("formats disabled state with help message", () => {
		const output = formatSearchOutput("query", {
			query: "query",
			durationMs: 0,
			status: "disabled",
			engine: "none",
			totalHits: 0,
			hits: [],
		});
		expect(output).toContain("Web search is disabled");
		expect(output).toContain("auth.json");
	});

	test("formats dual search output with verified sources and synthesis", () => {
		const hits: WebSearchHit[] = [
			{
				title: "React 19 Docs",
				url: "https://react.dev",
				snippet: "React 19 documentation.",
				sources: ["MiniMax", "DeepSeek"],
			},
		];
		const output = formatSearchOutput("react 19", {
			query: "react 19",
			durationMs: 1200,
			status: "success",
			engine: "dual",
			totalHits: 1,
			hits,
			deepseekSynthesis: "Synthesis points here.",
		});

		expect(output).toContain('# Web Search Results for: "react 19"');
		expect(output).toContain("[React 19 Docs](https://react.dev)");
		expect(output).toContain("verified by MiniMax & DeepSeek");
		expect(output).toContain("Synthesis points here.");
		expect(output).toContain("cite the relevant source URLs in your response");
		expect(output).not.toContain("CRITICAL REQUIREMENT");
		expect(output).not.toContain("Sources:");
	});

	test("does not request citations when synthesis has no source URLs", () => {
		const output = formatSearchOutput("react 19", {
			query: "react 19",
			durationMs: 1200,
			status: "success",
			engine: "deepseek",
			totalHits: 0,
			hits: [],
			deepseekSynthesis: "Synthesis without structured sources.",
		});

		expect(output).toContain("Synthesis without structured sources.");
		expect(output).not.toContain("cite the relevant source URLs");
		expect(output).not.toContain("Sources:");
	});
});

describe("renderWebSearchCall & renderWebSearchResult", () => {
	test("renderWebSearchCall renders label and query", () => {
		const comp = renderWebSearchCall({ query: "TypeScript 5.5" }, theme);
		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain('Web Search "TypeScript 5.5"');
	});

	test("renderWebSearchCall tolerates incomplete streaming arguments", () => {
		const comp = renderWebSearchCall(undefined, theme);
		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain('Web Search ""');
	});

	test("renderWebSearchResult renders collapsed summary with result counts and duration", () => {
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "Full search payload" }],
				details: {
					query: "TypeScript 5.5",
					durationMs: 1200,
					status: "success",
					engine: "dual",
					totalHits: 5,
					hits: [],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			false,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("5 results via MiniMax & DeepSeek · 1.2s");
		expect(lines[0]).toContain("ctrl+o to expand");
	});

	test("renderWebSearchResult renders disabled status nicely even with a legacy error flag", () => {
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "Disabled" }],
				details: {
					query: "test",
					durationMs: 0,
					status: "disabled",
					engine: "none",
					totalHits: 0,
					hits: [],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			true,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("disabled · no MiniMax/DeepSeek key — /login minimax-cn");
		expect(usedColors).toContain("warning");
		expect(usedColors).not.toContain("error");
	});

	test("renderWebSearchResult renders in-progress state without repeating the query", () => {
		const comp = renderWebSearchResult(
			{
				content: [],
				details: {
					query: "TypeScript 7 release",
					durationMs: 0,
					status: "success",
					engine: "dual",
					totalHits: 0,
					hits: [],
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			false,
			3000,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("Searching via MiniMax & DeepSeek... (3s)");
		expect(lines[0]).not.toContain("TypeScript 7 release");
	});

	test("renderWebSearchResult hides elapsed time below the 2s threshold", () => {
		const comp = renderWebSearchResult(
			{
				content: [],
				details: {
					query: "q",
					durationMs: 0,
					status: "success",
					engine: "minimax",
					totalHits: 0,
					hits: [],
				},
			},
			{ expanded: false, isPartial: true },
			theme,
			false,
			1200,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("Searching via MiniMax...");
		expect(lines[0]).not.toContain("(1s)");
	});

	test("renderWebSearchResult collapsed summary previews top hit domains", () => {
		const comp = renderWebSearchResult(
			{
				content: [{ type: "text", text: "payload" }],
				details: {
					query: "q",
					durationMs: 800,
					status: "success",
					engine: "dual",
					totalHits: 3,
					hits: [
						{ title: "A", url: "https://www.example.com/a", sources: ["MiniMax"] },
						{ title: "B", url: "https://foo.org/b", sources: ["DeepSeek"] },
						{ title: "C", url: "https://bar.net/c", sources: ["MiniMax"] },
					],
				},
			},
			{ expanded: false, isPartial: false },
			theme,
			false,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("3 results via MiniMax & DeepSeek · 0.8s · example.com, foo.org, +1");
	});

	test("renderWebSearchResult expanded renders structured sections without agent directives", () => {
		const comp = renderWebSearchResult(
			{
				content: [
					{
						type: "text",
						text: '# Web Search Results for: "q"\n\n...\n---\nUse these search results to answer the user, and cite the relevant source URLs in your response.',
					},
				],
				details: {
					query: "q",
					durationMs: 100,
					status: "success",
					engine: "deepseek",
					totalHits: 1,
					hits: [
						{ title: "Announcing X", url: "https://example.com/x", snippet: "A snippet", sources: ["DeepSeek"] },
					],
					deepseekSynthesis: "Synthesis text",
					relatedSearches: ["related one"],
				},
			},
			{ expanded: true, isPartial: false },
			theme,
			false,
		);

		const rendered = comp
			.render(120)
			.map((l) => stripAnsi(l))
			.join("\n");
		expect(rendered).toContain("Verified Web Sources (1 found via DeepSeek)");
		expect(rendered).toContain("Announcing X");
		expect(rendered).toContain("Key Technical Insights");
		expect(rendered).toContain("Related Searches");
		expect(rendered).not.toContain("cite the relevant source URLs");
	});

	test("renderWebSearchResult falls back to payload text when details are missing", () => {
		const comp = renderWebSearchResult(
			// Legacy sessions on disk may lack details even though the type requires it.
			{ content: [{ type: "text", text: "Some legacy payload line" }], details: undefined as never },
			{ expanded: false, isPartial: false },
			theme,
			false,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("Some legacy payload line");
		expect(lines[0]).toContain("ctrl+o to expand");
	});
});
