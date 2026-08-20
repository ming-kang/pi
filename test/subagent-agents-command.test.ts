import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type TUI,
	type KeybindingsManager as TuiKeybindingsManager,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { showAgentsCommand } from "../src/extensions/subagent/agents-command.ts";
import * as settings from "../src/extensions/subagent/settings.ts";
import {
	buildModelChoices,
	buildSettingsRows,
	buildThinkingChoices,
	compareModels,
} from "../src/extensions/subagent/ui/choices.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

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

	it("keeps one TUI lifecycle while navigating back and commits each selection immediately", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let customCalls = 0;
		let nestedBackStayedOpen = false;
		const savedMenuRender: string[] = [];
		const custom = async <T>(
			factory: (
				tui: TUI,
				themeValue: Theme,
				keybindings: TuiKeybindingsManager,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				let settled = false;
				const done = (result: T) => {
					settled = true;
					resolve(result);
				};
				void Promise.resolve(
					factory({ requestRender: vi.fn() } as unknown as TUI, theme, new KeybindingsManager(), done),
				)
					.then(async (component) => {
						customCalls++;
						const interactive = component as unknown as {
							handleInput(data: string): void;
							render(width: number): string[];
						};
						const render = () => stripAnsi(interactive.render(100).join("\n"));
						const choose = (label: string) => {
							for (let index = 0; index < 12; index++) {
								const selected = render()
									.split("\n")
									.find((line) => line.includes("→"));
								if (selected?.includes(label)) {
									interactive.handleInput("\r");
									return;
								}
								interactive.handleInput("\x1b[B");
							}
							throw new Error(`Could not select ${label}`);
						};

						expect(render()).toContain("Agents");
						interactive.handleInput("\r");
						expect(render()).toContain("Model — inherit");

						// Esc from profile settings switches the mounted child back to
						// the profile list; it must not resolve ctx.ui.custom().
						interactive.handleInput("\x1b");
						expect(settled).toBe(false);
						expect(render()).toContain("General");
						nestedBackStayedOpen = true;

						interactive.handleInput("\r");
						interactive.handleInput("\x1b[B");
						interactive.handleInput("\r");
						choose("high");
						await vi.waitFor(() => expect(render()).toContain("override — high ✓"));

						interactive.handleInput("\x1b[A");
						interactive.handleInput("\r");
						choose("worker [provider]");
						await vi.waitFor(() => expect(render()).toContain("override — provider/worker ✓"));

						savedMenuRender.push(render());
						interactive.handleInput("\x1b");
						expect(settled).toBe(false);
						expect(render()).toContain("Agents");
						interactive.handleInput("\x1b");
					})
					.catch(reject);
			});
		const select = vi.fn();
		const ctx = {
			...baseContext(root, activeModel),
			mode: "tui",
			ui: { custom, select, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "medium");
		expect(customCalls).toBe(1);
		expect(select).not.toHaveBeenCalled();
		expect(nestedBackStayedOpen).toBe(true);
		expect(savedMenuRender.join("\n")).toContain("override — provider/worker ✓");
		expect(savedMenuRender.join("\n")).toContain("override — high ✓");
		expect(configAt(root).profiles.explorer).toEqual({ model: "provider/worker", thinking: "high" });
	});

	it("does not mount an editor frame when Esc returns from settings to profiles", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		const editorContainer = new Container();
		const editor = new (class implements Component {
			focused = false;
			renderCount = 0;
			private text = "";

			render(): string[] {
				this.renderCount++;
				return ["EDITOR"];
			}

			getText(): string {
				return this.text;
			}

			setText(text: string): void {
				this.text = text;
			}

			invalidate(): void {}
		})();
		const fakeMode = {
			editor,
			editorContainer,
			keybindings: new KeybindingsManager(),
			ui: tui,
			disposeActiveSelector: vi.fn(),
		};
		const custom = <T>(
			factory: (
				tuiValue: TUI,
				themeValue: Theme,
				keybindings: TuiKeybindingsManager,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T> => (InteractiveMode as any).prototype.showExtensionCustom.call(fakeMode, factory) as Promise<T>;
		const ctx = {
			...baseContext(root, activeModel),
			mode: "tui",
			ui: { custom, select: vi.fn(), notify: vi.fn() },
		} as unknown as ExtensionCommandContext;
		const sendInput = async (data: string) => {
			await new Promise<void>((resolve) => {
				setImmediate(() => {
					terminal.sendInput(data);
					resolve();
				});
			});
			await terminal.waitForRender();
		};

		editorContainer.addChild(editor);
		tui.addChild(editorContainer);
		tui.setFocus(editor);
		tui.start();
		try {
			const command = showAgentsCommand(ctx, "medium");
			await vi.waitFor(() => expect(editorContainer.children[0]).not.toBe(editor));
			await terminal.waitForRender();

			await sendInput("\r");
			expect((await terminal.flushAndGetViewport()).join("\n")).toContain("Explorer");
			editor.renderCount = 0;

			await sendInput("\x1b");
			expect(editor.renderCount).toBe(0);
			expect((await terminal.flushAndGetViewport()).join("\n")).toContain("Agents");

			await sendInput("\r");
			await sendInput("\r");
			editor.renderCount = 0;
			await sendInput("\x1b");
			expect(editor.renderCount).toBe(0);

			await sendInput("\x1b[B");
			await sendInput("\r");
			editor.renderCount = 0;
			await sendInput("\x1b");
			expect(editor.renderCount).toBe(0);

			await sendInput("\x1b");
			await sendInput("\x1b");
			await command;
			expect(editor.renderCount).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("aborts an in-flight model refresh when leaving the model page", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let refreshSignal: AbortSignal | undefined;
		const refresh = vi.fn(
			({ signal }: { signal: AbortSignal }) =>
				new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
					refreshSignal = signal;
					signal.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), { once: true });
				}),
		);
		const custom = async <T>(
			factory: (
				tui: TUI,
				themeValue: Theme,
				keybindings: TuiKeybindingsManager,
				done: (result: T) => void,
			) => Component | Promise<Component>,
		): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				void Promise.resolve(
					factory({ requestRender: vi.fn() } as unknown as TUI, theme, new KeybindingsManager(), resolve),
				)
					.then((component) => {
						const interactive = component as unknown as { handleInput(data: string): void };
						interactive.handleInput("\r");
						interactive.handleInput("\r");
						expect(refreshSignal).toBeDefined();
						interactive.handleInput("\x1b");
						expect(refreshSignal?.aborted).toBe(true);
						interactive.handleInput("\x1b");
						interactive.handleInput("\x1b");
					})
					.catch(reject);
			});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "tui",
			modelRegistry: { ...registry([activeModel]), refresh },
			ui: { custom, select: vi.fn(), notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "medium");
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("allows Esc to close the TUI while an override save is still pending", async () => {
		const root = temporaryAgentDir();
		const activeModel = model("provider", "worker");
		let finishSave: (config: ReturnType<typeof settings.emptySubagentConfig>) => void = () => {
			throw new Error("save resolver was not initialized");
		};
		const pendingSave = new Promise<ReturnType<typeof settings.emptySubagentConfig>>((resolve) => {
			finishSave = resolve;
		});
		const saveSpy = vi.spyOn(settings, "updateProfileOverride").mockReturnValue(pendingSave);
		const custom = async <T>(
			factory: (
				tui: TUI,
				themeValue: Theme,
				keybindings: TuiKeybindingsManager,
				done: (result: T) => void,
			) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				let mounted: (Component & { dispose?(): void }) | undefined;
				let settled = false;
				const done = (result: T) => {
					settled = true;
					mounted?.dispose?.();
					resolve(result);
				};
				void Promise.resolve(
					factory({ requestRender: vi.fn() } as unknown as TUI, theme, new KeybindingsManager(), done),
				)
					.then((component) => {
						mounted = component;
						const interactive = component as unknown as {
							handleInput(data: string): void;
							render(width: number): string[];
						};
						const render = () => stripAnsi(interactive.render(100).join("\n"));
						interactive.handleInput("\r");
						interactive.handleInput("\r");
						interactive.handleInput("\x1b[B");
						interactive.handleInput("\r");
						expect(render()).toContain("Saving…");

						interactive.handleInput("\x1b");
						expect(settled).toBe(false);
						expect(render()).toContain("Agents");
						interactive.handleInput("\x1b");
					})
					.catch(reject);
			});
		const ctx = {
			...baseContext(root, activeModel),
			mode: "tui",
			ui: { custom, select: vi.fn(), notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await showAgentsCommand(ctx, "medium");
		expect(saveSpy).toHaveBeenCalledWith("explorer", { model: "provider/worker" }, root);
		finishSave(settings.emptySubagentConfig());
		await Promise.resolve();
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

describe("/agents shared choice builders", () => {
	const session = model("anthropic", "claude-x");
	const catalog = [model("provider", "worker"), session];

	it("builds settings rows for inherit, override, and unavailable overrides", () => {
		const inherited = buildSettingsRows({
			override: undefined,
			models: catalog,
			currentSessionModel: session,
			currentThinking: "medium",
		});
		expect(inherited).toEqual([
			{ action: "model", label: "Model", value: "inherit — anthropic/claude-x", override: false },
			{ action: "thinking", label: "Thinking", value: "inherit — medium", override: false },
		]);

		const overridden = buildSettingsRows({
			override: { model: "provider/worker", thinking: "high" },
			models: catalog,
			currentSessionModel: session,
			currentThinking: "medium",
		});
		expect(overridden[0]).toMatchObject({
			action: "model",
			value: "override — provider/worker",
			override: true,
		});
		expect(overridden[1]).toMatchObject({ action: "thinking", value: "override — high", override: true });

		const unavailable = buildSettingsRows({
			override: { model: "gone/model" },
			models: catalog,
			currentSessionModel: session,
			currentThinking: "medium",
		});
		expect(unavailable[0]?.value).toBe("override — gone/model [unavailable]");
	});

	it("builds model choices with inherit, saved-unavailable, and catalog entries", () => {
		const inherited = buildModelChoices({
			models: [...catalog].sort(compareModels),
			currentSessionModel: session,
			savedModelId: undefined,
		});
		expect([...inherited.keys()]).toEqual([
			"inherit (anthropic/claude-x) ✓",
			"anthropic/claude-x",
			"provider/worker",
		]);

		const overridden = buildModelChoices({
			models: [...catalog].sort(compareModels),
			currentSessionModel: session,
			savedModelId: "provider/worker",
		});
		expect(overridden.get("provider/worker ✓")).toBe("provider/worker");
		expect(overridden.get("inherit (anthropic/claude-x)")).toBeUndefined();

		const unavailable = buildModelChoices({
			models: [...catalog].sort(compareModels),
			currentSessionModel: session,
			savedModelId: "gone/model",
		});
		expect(unavailable.get("gone/model [unavailable] ✓")).toBe("gone/model");
	});

	it("builds thinking choices from the effective model's supported levels", () => {
		const choices = buildThinkingChoices({
			currentSessionModel: session,
			models: catalog,
			override: undefined,
			currentThinking: "medium",
		});
		expect(choices.get("inherit (medium) ✓")).toBeUndefined();
		expect([...choices.keys()][1]).toBe("off");

		const overridden = buildThinkingChoices({
			currentSessionModel: session,
			models: catalog,
			override: { thinking: "high" },
			currentThinking: "medium",
		});
		expect(overridden.get("high ✓")).toBe("high");
	});
});
