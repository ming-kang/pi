import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { syncTools } from "../src/extensions/search/command.ts";
import { saveCredential } from "../src/extensions/search/credential.ts";
import search from "../src/extensions/search/index.ts";

function fakePi(active: string[]) {
	let sessionStart: (() => Promise<void>) | undefined;
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event: string, handler: () => Promise<void>) => {
			if (event === "session_start") sessionStart = handler;
		},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	} as unknown as ExtensionAPI;
	search(pi);
	return { pi, active: () => active, startSession: () => sessionStart!() };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "search-lifecycle-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.SEARCH_KEY;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("search tool activation", () => {
	it("starts a session without a credential with both tools off", async () => {
		const session = fakePi(["read", "code_search", "web_search"]);
		await session.startSession();
		expect(session.active()).toEqual(["read"]);
	});

	it("does not re-enable a tool the user turned off just because a credential exists", async () => {
		saveCredential("devin-session-token$x");
		const session = fakePi(["read", "code_search"]);
		await session.startSession();
		expect(session.active()).toEqual(["read", "code_search"]);
	});

	it("turns both tools on after a sign-in", () => {
		const session = fakePi(["read"]);
		saveCredential("devin-session-token$x");
		syncTools(session.pi, true);
		expect(session.active()).toEqual(["read", "code_search", "web_search"]);
	});
});
