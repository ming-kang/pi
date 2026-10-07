import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";

const KEY = "devin-session-token$eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig";

interface RegisteredCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface MockApi {
	api: ExtensionAPI;
	registeredTools: string[];
	registeredCommands: string[];
	commands: Map<string, RegisteredCommand>;
	getActive: () => string[];
	fireSessionStart: () => Promise<void>;
}

async function setup(activeTools: string[]): Promise<MockApi> {
	const tools: string[] = [];
	const commands = new Map<string, RegisteredCommand>();
	let active = [...activeTools];
	let sessionStart: (() => Promise<void>) | undefined;
	const setActiveTools = vi.fn((names: string[]) => {
		active = [...names];
	});
	const api = {
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerCommand: (name: string, options: RegisteredCommand) => commands.set(name, options),
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
		registeredCommands: [...commands.keys()],
		commands,
		getActive: () => active,
		fireSessionStart: async () => {
			await sessionStart?.();
		},
	};
}

function keyFile(): string {
	return join(dir, "search", "config.json");
}

function saveKey(source: "manual" | "oauth"): void {
	mkdirSync(join(dir, "search"), { recursive: true });
	writeFileSync(keyFile(), JSON.stringify({ apiKey: KEY, source }));
}

interface MenuCall {
	title: string;
	options: string[];
}

interface RunResult {
	selectCalls: MenuCall[];
	notices: string[];
}

/** Run `/search` against a scripted UI, where `choice` is the label the menu resolves to. */
async function runSearch(
	mock: MockApi,
	choice: string | undefined,
	script: { confirmed?: boolean; input?: string; hasUI?: boolean } = {},
): Promise<RunResult> {
	const selectCalls: MenuCall[] = [];
	const notices: string[] = [];
	const ctx = {
		hasUI: script.hasUI ?? true,
		ui: {
			select: async (title: string, options: string[]) => {
				selectCalls.push({ title, options });
				return choice;
			},
			confirm: async () => script.confirmed ?? true,
			input: async () => script.input,
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionCommandContext;
	const command = mock.commands.get("search");
	if (!command) throw new Error("/search was not registered");
	await command.handler("", ctx);
	return { selectCalls, notices };
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
	it("registers code_search, web_search, and the one /search command", async () => {
		const mock = await setup(["read", "bash", "edit", "write"]);
		expect(mock.registeredTools).toEqual(["code_search", "web_search"]);
		expect(mock.registeredCommands).toEqual(["search"]);
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
		saveKey("manual");
		const mock = await setup(["read", "bash"]);
		await mock.fireSessionStart();
		expect(mock.getActive()).toEqual(["read", "bash", "code_search", "web_search"]);
	});
});

describe("/search menu", () => {
	it("offers only the two sign-in rows when no key exists", async () => {
		const mock = await setup(["read"]);
		const { selectCalls } = await runSearch(mock, undefined);
		expect(selectCalls).toHaveLength(1);
		expect(selectCalls[0]!.title).toBe("Devin Search");
		expect(selectCalls[0]!.options).toEqual(["Sign in with Devin account", "Sign in with Devin key"]);
	});

	it("adds a clear row once a key is saved, keeping the heading free of state", async () => {
		saveKey("oauth");
		const mock = await setup(["read"]);
		const { selectCalls } = await runSearch(mock, undefined);
		expect(selectCalls[0]!.options).toEqual([
			"Sign in with Devin account",
			"Sign in with Devin key",
			"Clear saved key",
		]);
		expect(selectCalls[0]!.title).toBe("Devin Search");
	});

	it("clears the key and disables both tools once the confirmation is accepted", async () => {
		saveKey("manual");
		const mock = await setup(["read", "code_search", "web_search"]);
		const { notices } = await runSearch(mock, "Clear saved key", { confirmed: true });
		expect(existsSync(keyFile())).toBe(false);
		expect(mock.getActive()).toEqual(["read"]);
		expect(notices.join("\n")).toContain("signed out");
	});

	it("leaves the key and the tools alone when the confirmation is declined", async () => {
		saveKey("manual");
		const mock = await setup(["read", "code_search"]);
		await runSearch(mock, "Clear saved key", { confirmed: false });
		expect(existsSync(keyFile())).toBe(true);
		expect(mock.getActive()).toEqual(["read", "code_search"]);
	});

	it("treats an empty key dialog as a no-op rather than a sign-out", async () => {
		saveKey("manual");
		const mock = await setup(["read", "code_search"]);
		const { notices } = await runSearch(mock, "Sign in with Devin key", { input: "   " });
		expect(existsSync(keyFile())).toBe(true);
		expect(mock.getActive()).toEqual(["read", "code_search"]);
		expect(notices.join("\n")).toContain("nothing changed");
	});

	it("offers no clear row for a key that comes from SEARCH_KEY", async () => {
		process.env.SEARCH_KEY = KEY;
		const mock = await setup(["read", "code_search"]);
		const { selectCalls } = await runSearch(mock, undefined);
		expect(selectCalls[0]!.options).not.toContain("Clear saved key");
		expect(selectCalls[0]!.title).toContain("SEARCH_KEY");
	});
});
