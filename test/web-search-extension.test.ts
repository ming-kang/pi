import { setKeybindings } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { resolveSearchCredentials } from "../src/extensions/web-search/auth.ts";
import { formatSearchOutput, fuseSearchHits, normalizeUrl } from "../src/extensions/web-search/fusion.ts";
import { renderWebSearchCall, renderWebSearchResult } from "../src/extensions/web-search/render.ts";
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

describe("normalizeWebSearchParams", () => {
	test("normalizes plain string query", () => {
		const result = normalizeWebSearchParams("  react 19  ");
		expect(result.query).toBe("react 19");
		expect(result.allowed_domains).toBeUndefined();
	});

	test("normalizes aliased fields (q, search_query)", () => {
		expect(normalizeWebSearchParams({ q: "typescript 5.5" }).query).toBe("typescript 5.5");
		expect(normalizeWebSearchParams({ search_query: "bun 1.1" }).query).toBe("bun 1.1");
	});

	test("parses domain filters", () => {
		const res1 = normalizeWebSearchParams({
			query: "nextjs",
			allowed_domains: ["nextjs.org", "github.com"],
		});
		expect(res1.allowed_domains).toEqual(["nextjs.org", "github.com"]);
		expect(res1.blocked_domains).toBeUndefined();

		const res2 = normalizeWebSearchParams({
			query: "nextjs",
			blocked_domains: "spam.com",
		});
		expect(res2.blocked_domains).toEqual(["spam.com"]);
	});

	test("allowed_domains wins when both filters are provided", () => {
		const res = normalizeWebSearchParams({
			query: "nextjs",
			allowed_domains: ["nextjs.org"],
			blocked_domains: ["spam.com"],
		});
		expect(res.allowed_domains).toEqual(["nextjs.org"]);
		expect(res.blocked_domains).toBeUndefined();
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
		expect(creds.mode).toBe("dual");
		expect(creds.minimaxKey).toBe("mm-key");
		expect(creds.minimaxHost).toBe("https://api.minimaxi.com");
		expect(creds.deepseekKey).toBe("ds-key");
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
		expect(creds.mode).toBe("deepseek");
		expect(creds.deepseekKey).toBe("ds-key");
	});

	test("falls back to auth.json when no runtime is available", async () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ "minimax-cn": { type: "api_key", key: "mm-file-key" } }));
		const creds = await resolveSearchCredentials(undefined, authPath);
		expect(creds.mode).toBe("minimax");
		expect(creds.minimaxKey).toBe("mm-file-key");
		expect(creds.minimaxHost).toBe("https://api.minimaxi.com");
	});

	test("falls back to environment variables when the runtime has nothing", async () => {
		process.env.MINIMAX_API_KEY = "mm-env-key";
		process.env.MINIMAX_API_HOST = "https://minimax.example.com/";
		process.env.DEEPSEEK_API_KEY = "ds-env-key";
		const creds = await resolveSearchCredentials(stubModelRuntime({}), missingAuthPath);
		expect(creds.mode).toBe("dual");
		expect(creds.minimaxKey).toBe("mm-env-key");
		expect(creds.minimaxHost).toBe("https://minimax.example.com/");
		expect(creds.deepseekKey).toBe("ds-env-key");
	});

	test("survives getAuth failures and reports none when nothing is configured", async () => {
		const runtime = {
			getAuth: async () => {
				throw new Error("unknown provider");
			},
		} as unknown as ModelRuntime;
		const creds = await resolveSearchCredentials(runtime, missingAuthPath);
		expect(creds.mode).toBe("none");
		expect(creds.minimaxKey).toBeUndefined();
		expect(creds.deepseekKey).toBeUndefined();
	});
});

describe("normalizeUrl", () => {
	test("strips tracking parameters and fragments", () => {
		const raw = "https://example.com/page?utm_source=twitter&utm_medium=social&ref=blog#section1";
		expect(normalizeUrl(raw)).toBe("https://example.com/page");
	});

	test("preserves non-tracking query parameters", () => {
		const raw = "https://example.com/search?q=hello&utm_source=test";
		expect(normalizeUrl(raw)).toBe("https://example.com/search?q=hello");
	});

	test("strips trailing slashes on path", () => {
		expect(normalizeUrl("https://example.com/docs/")).toBe("https://example.com/docs");
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
		expect(output).toContain("CRITICAL REQUIREMENT FOR MAIN AGENT");
		expect(output).toContain("Sources:");
	});
});

describe("renderWebSearchCall & renderWebSearchResult", () => {
	test("renderWebSearchCall renders label and query", () => {
		const comp = renderWebSearchCall(
			{
				query: "TypeScript 5.5",
				allowed_domains: ["typescriptlang.org"],
			},
			theme,
		);
		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain('Web Search "TypeScript 5.5"');
		expect(lines[0]).toContain("[sites: typescriptlang.org]");
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
		expect(lines[0]).toContain("5 results via MiniMax + DeepSeek · 1.2s");
		expect(lines[0]).toContain("ctrl+o to expand");
	});

	test("renderWebSearchResult renders disabled status nicely", () => {
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
			false,
		);

		const lines = comp.render(120).map((l) => stripAnsi(l).trimEnd());
		expect(lines[0]).toContain("disabled · No MiniMax or DeepSeek API Key found");
	});
});
