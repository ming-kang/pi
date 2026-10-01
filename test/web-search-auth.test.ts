import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { configuredEngine, resolveSearchCredentials } from "../src/extensions/web-search/auth.ts";

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
