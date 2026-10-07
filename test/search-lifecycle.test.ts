import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

interface MockApi {
	api: ExtensionAPI;
	registeredTools: string[];
	registeredCommands: string[];
	getActive: () => string[];
	fireSessionStart: () => Promise<void>;
}

async function setup(activeTools: string[]): Promise<MockApi> {
	const tools: string[] = [];
	const commands: string[] = [];
	let active = [...activeTools];
	let sessionStart: (() => Promise<void>) | undefined;
	const setActiveTools = vi.fn((names: string[]) => {
		active = [...names];
	});
	const api = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_start") sessionStart = handler;
		},
		getActiveTools: () => [...active],
		setActiveTools,
	} as unknown as ExtensionAPI;
	const search = (await import("../src/extensions/search/index.ts")).default;
	search(api);
	return {
		api,
		registeredTools: tools,
		registeredCommands: commands,
		getActive: () => active,
		fireSessionStart: async () => {
			await sessionStart?.();
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "search-lifecycle-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.SEARCH_KEY;
	vi.resetModules();
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.SEARCH_KEY;
});

describe("search extension lifecycle", () => {
	it("registers code_search, web_search, and the four commands", async () => {
		const mock = await setup(["read", "bash", "edit", "write"]);
		expect(mock.registeredTools).toEqual(["code_search", "web_search"]);
		expect(mock.registeredCommands).toEqual(["search-key", "search-login", "search-status", "search-logout"]);
	});

	it("removes both tools from the active set on session start with no key", async () => {
		const mock = await setup(["read", "code_search", "web_search", "bash"]);
		await mock.fireSessionStart();
		expect(mock.getActive()).toEqual(["read", "bash"]);
	});

	it("keeps the active set untouched on session start with no key and no tools", async () => {
		const mock = await setup(["read", "bash"]);
		await mock.fireSessionStart();
		expect(mock.getActive()).toEqual(["read", "bash"]);
	});

	it("adds both tools back once a key is saved", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(dir, "search"), { recursive: true });
		writeFileSync(
			join(dir, "search", "config.json"),
			JSON.stringify({ apiKey: "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig", source: "manual" }),
		);
		const mock = await setup(["read", "bash"]);
		await mock.fireSessionStart();
		expect(mock.getActive()).toEqual(["read", "bash", "code_search", "web_search"]);
	});
});
