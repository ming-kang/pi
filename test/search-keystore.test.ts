import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln";
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "search-keystore-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.SEARCH_KEY;
	vi.resetModules();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.SEARCH_KEY;
});

async function loadKeystore() {
	return await import("../src/extensions/search/keystore.ts");
}

describe("search keystore", () => {
	it("starts empty with no file and no env", async () => {
		const ks = await loadKeystore();
		expect(ks.getApiKey()).toBeUndefined();
		expect(ks.getKeyInfo()).toBeUndefined();
	});

	it("persists a manual key under <agentDir>/search/config.json", async () => {
		const ks = await loadKeystore();
		ks.setApiKey(KEY, "manual");
		const file = join(dir, "search", "config.json");
		expect(existsSync(file)).toBe(true);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		expect(saved).toMatchObject({ apiKey: KEY, source: "manual" });
		expect(typeof saved.obtainedAt).toBe("string");
		expect(ks.getKeyInfo()).toEqual({ key: KEY, source: "manual" });
	});

	it("persists an oauth key with its source", async () => {
		const ks = await loadKeystore();
		ks.setApiKey(KEY, "oauth");
		expect(ks.getKeyInfo()?.source).toBe("oauth");
	});

	it("removes the file on clear", async () => {
		const ks = await loadKeystore();
		ks.setApiKey(KEY, "manual");
		ks.clearApiKey();
		expect(existsSync(join(dir, "search", "config.json"))).toBe(false);
		expect(ks.getApiKey()).toBeUndefined();
	});

	it("falls back to SEARCH_KEY when no file exists", async () => {
		process.env.SEARCH_KEY = KEY;
		const ks = await loadKeystore();
		expect(ks.getApiKey()).toBe(KEY);
		expect(ks.getKeyInfo()?.source).toBe("env");
	});

	it("prefers the saved file over SEARCH_KEY", async () => {
		process.env.SEARCH_KEY = "devin-session-token$env.env.env";
		const ks = await loadKeystore();
		ks.setApiKey(KEY, "manual");
		expect(ks.getApiKey()).toBe(KEY);
		expect(ks.getKeyInfo()?.source).toBe("manual");
	});

	it("reloads a saved key into a freshly imported module", async () => {
		const first = await loadKeystore();
		first.setApiKey(KEY, "oauth");
		vi.resetModules();
		const second = await loadKeystore();
		expect(second.getApiKey()).toBe(KEY);
		expect(second.getKeyInfo()?.source).toBe("oauth");
	});

	it("ignores an empty or whitespace-only key on set", async () => {
		const ks = await loadKeystore();
		ks.setApiKey("   ", "manual");
		expect(ks.getApiKey()).toBeUndefined();
	});

	it("maskKey shows head and tail only", async () => {
		const ks = await loadKeystore();
		const masked = ks.maskKey(KEY);
		expect(masked.startsWith("devin-session-token$eyJ")).toBe(true);
		expect(masked.endsWith("c2ln")).toBe(true);
		expect(masked).not.toBe(KEY);
		expect(masked.length).toBeLessThan(KEY.length);
	});
});
