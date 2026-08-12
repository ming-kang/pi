import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Component, TUI, KeybindingsManager as TuiKeybindingsManager } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { showAgentsCommand } from "../src/extensions/subagent/agents-command.ts";
import * as settings from "../src/extensions/subagent/settings.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
		vi.restoreAllMocks();
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

	function configAt(root: string): ReturnType<typeof settings.parseSubagentConfig> {
		return settings.parseSubagentConfig(readFileSync(join(root, "subagent.json"), "utf8"));
	}

	it("lists exactly the two static profiles and persists RPC selections immediately", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let agentsSelections = 0;
		let menuSelections = 0;
		const seenAgentOptions: string[][] = [];
		let modelSavedBeforeThinking: unknown;
		const select = vi.fn(async (title: string, options: string[]) => {
			if (title === "Agents") {
				seenAgentOptions.push(options);
				agentsSelections++;
				return agentsSelections === 1 ? "General" : undefined;
			}
			if (title === "General") {
				menuSelections++;
				if (menuSelections === 1) return options.find((option) => option.startsWith("Model"));
				if (menuSelections === 2) return options.find((option) => option.startsWith("Thinking"));
				return undefined;
			}
			if (title === "Model — General") return options.find((option) => option === "provider/worker");
			if (title === "Thinking — General") {
				// The model override is already on disk when the thinking picker
				// opens: no apply step or draft waits for the end of the flow.
				modelSavedBeforeThinking = configAt(root);
				return options.find((option) => option === "off");
			}
			return undefined;
		});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "rpc",
			ui: { select, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "medium");
		expect(seenAgentOptions).toHaveLength(2);
		expect(seenAgentOptions[0]).toEqual(["Explorer", "General"]);
		expect(modelSavedBeforeThinking).toEqual({
			version: 1,
			profiles: { general: { model: "provider/worker" } },
		});
		expect(configAt(root).profiles.general).toEqual({ model: "provider/worker", thinking: "off" });
	});

	it("clears saved overrides immediately when inherit is selected", async () => {
		const root = temporaryAgentDir();
		await settings.updateProfileOverride("explorer", { model: "provider/worker", thinking: "high" }, root);
		const activeModel = model("provider", "worker");
		let agentsSelections = 0;
		let menuSelections = 0;
		let thinkingAfterModelClear: unknown;
		const select = vi.fn(async (title: string, options: string[]) => {
			if (title === "Agents") {
				agentsSelections++;
				return agentsSelections === 1 ? "Explorer" : undefined;
			}
			if (title === "Explorer") {
				menuSelections++;
				if (menuSelections === 1) return options.find((option) => option.startsWith("Model"));
				if (menuSelections === 2) return options.find((option) => option.startsWith("Thinking"));
				return undefined;
			}
			if (title === "Model — Explorer") return options.find((option) => option.startsWith("inherit"));
			if (title === "Thinking — Explorer") {
				thinkingAfterModelClear = configAt(root);
				return options.find((option) => option.startsWith("inherit"));
			}
			return undefined;
		});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "rpc",
			ui: { select, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "medium");
		// Model reverted as soon as inherit was confirmed; thinking still set.
		expect(thinkingAfterModelClear).toEqual({ version: 1, profiles: { explorer: { thinking: "high" } } });
		expect(configAt(root).profiles.explorer).toBeUndefined();
	});

	it("runs the unified TUI flow and commits each selection immediately", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let customCalls = 0;
		const savedMenuRender: string[] = [];
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
					const interactive = component as unknown as {
						handleInput(data: string): void;
						render(width: number): string[];
					};
					if (customCalls === 1) {
						// Settings menu: move to Thinking and confirm it.
						interactive.handleInput("\x1b[B");
						interactive.handleInput("\r");
					} else if (customCalls === 2) {
						// Settings menu: confirm Model on the first row.
						interactive.handleInput("\r");
					} else if (customCalls === 3) {
						// Model picker: step past the inherit row to provider/worker.
						interactive.handleInput("\x1b[B");
						interactive.handleInput("\r");
					} else {
						// Settings menu: both overrides visible, then back out.
						savedMenuRender.push(stripAnsi(interactive.render(80).join("\n")));
						interactive.handleInput("\x1b");
					}
				});
			});
		let agentsSelections = 0;
		const select = vi.fn(async (title: string, options: string[]) => {
			if (title === "Agents") {
				agentsSelections++;
				return agentsSelections === 1 ? "Explorer" : undefined;
			}
			if (title === "Thinking — Explorer") return options.find((option) => option === "high");
			return undefined;
		});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "tui",
			ui: { custom, select, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "medium");
		expect(customCalls).toBe(4);
		// The last menu shows the already-persisted overrides: selections are
		// committed as they are confirmed, with no apply/save draft step.
		expect(savedMenuRender.join("\n")).toContain("override — provider/worker ✓");
		expect(savedMenuRender.join("\n")).toContain("override — high ✓");
		expect(configAt(root).profiles.explorer).toEqual({ model: "provider/worker", thinking: "high" });
	});

	it("reports save failures and continues without writing a partial config", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		const saveSpy = vi.spyOn(settings, "updateProfileOverride").mockRejectedValue(new Error("disk full"));
		const notify = vi.fn();
		let agentsSelections = 0;
		let menuSelections = 0;
		const select = vi.fn(async (title: string, options: string[]) => {
			if (title === "Agents") {
				agentsSelections++;
				return agentsSelections === 1 ? "Explorer" : undefined;
			}
			if (title === "Explorer") {
				menuSelections++;
				if (menuSelections === 1) return options.find((option) => option.startsWith("Model"));
				return undefined;
			}
			if (title === "Model — Explorer") return options.find((option) => option === "provider/worker");
			return undefined;
		});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "rpc",
			ui: { select, notify },
		} as unknown as ExtensionCommandContext;

		await expect(showAgentsCommand(ctx, "medium")).resolves.toBeUndefined();
		expect(saveSpy).toHaveBeenCalledWith("explorer", { model: "provider/worker" }, root);
		expect(notify).toHaveBeenCalledWith("Could not save Explorer settings: disk full", "error");
		// The failed override never reached the config file.
		expect(existsSync(join(root, "subagent.json"))).toBe(false);
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
