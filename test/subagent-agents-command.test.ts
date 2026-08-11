import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Component, TUI, KeybindingsManager as TuiKeybindingsManager } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { showAgentsCommand } from "../src/extensions/subagent/agents-command.ts";
import { parseSubagentConfig } from "../src/extensions/subagent/settings.ts";
import { ProfileEditorComponent } from "../src/extensions/subagent/ui/profile-editor.ts";
import { ProfilePickerComponent } from "../src/extensions/subagent/ui/profile-picker.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function registry(models: Model<Api>[]) {
	return {
		getAvailable: () => [...models],
		getError: () => undefined,
		refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
	};
}

function baseContext(root: string, activeModel: Model<Api>) {
	return {
		cwd: root,
		hasUI: true,
		model: activeModel,
		scopedModels: [],
		modelRegistry: registry([activeModel]),
		isProjectTrusted: () => false,
	};
}

describe("/agents command", () => {
	const roots: string[] = [];
	let previousAgentDir: string | undefined;

	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		previousAgentDir = undefined;
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function temporaryAgentDir(): string {
		const root = mkdtempSync(join(tmpdir(), "pi-subagent-agents-command-"));
		roots.push(root);
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = root;
		return root;
	}

	it("keeps RPC labels sorted and saves lower-case identifiers atomically", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let agentsSelections = 0;
		const seenAgentOptions: string[][] = [];
		const select = vi.fn(async (title: string, options: string[]) => {
			if (title === "Agents") {
				seenAgentOptions.push(options);
				agentsSelections++;
				return agentsSelections === 1 ? "Explorer" : undefined;
			}
			if (title === "Model for Explorer") return options.find((option) => option === "provider/worker");
			if (title === "Thinking for Explorer") return options.find((option) => option === "off");
			return undefined;
		});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "rpc",
			ui: { select, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "high");
		expect(seenAgentOptions[0]?.slice(0, 2)).toEqual(["Explorer", "General"]);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config.profiles).toEqual({ explorer: { model: "provider/worker", thinking: "off" } });
	});

	it("runs the unified TUI flow and commits the editor result", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let customCalls = 0;
		const custom = async <T>(
			factory: (
				tui: TUI,
				themeValue: Theme,
				keybindings: TuiKeybindingsManager,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T> =>
			new Promise<T>((resolve) => {
				void Promise.resolve(
					factory({ requestRender: vi.fn() } as unknown as TUI, theme, new KeybindingsManager(), resolve),
				).then((component) => {
					customCalls++;
					if (component instanceof ProfilePickerComponent) {
						component.handleInput(customCalls === 1 ? "\r" : "\x1b");
						return;
					}
					if (component instanceof ProfileEditorComponent) {
						component.handleInput("\x1b[B");
						component.handleInput("\x1b[Z");
						component.handleInput("\r");
					}
				});
			});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "tui",
			ui: { custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "high");
		expect(customCalls).toBe(3);
		const config = parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
		expect(config.profiles).toEqual({ explorer: { model: "provider/worker", thinking: "off" } });
	});

	it("warns instead of opening selectors without interactive UI", async () => {
		const notify = vi.fn();
		await showAgentsCommand(
			{ hasUI: false, mode: "print", ui: { notify } } as unknown as ExtensionCommandContext,
			"medium",
		);
		expect(notify).toHaveBeenCalledWith("/agents requires an interactive UI.", "warning");
	});
});
