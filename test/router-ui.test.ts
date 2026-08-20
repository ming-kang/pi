import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Component,
	Container,
	type TUI,
	type KeybindingsManager as TuiKeybindingsManager,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { applyRouterFile } from "../src/extensions/router/register.ts";
import { parseRouterFile } from "../src/extensions/router/store.ts";
import { runRouterCommand } from "../src/extensions/router/ui.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

type CustomComponent = Component & { dispose?(): void };
type CustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: TuiKeybindingsManager,
	done: (result: T) => void,
) => CustomComponent | Promise<CustomComponent>;
type ShowExtensionCustom = <T>(this: unknown, factory: CustomFactory<T>) => Promise<T>;

class FakeEditor implements Component {
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
}

interface TuiHarness {
	ctx: ExtensionCommandContext;
	editor: FakeEditor;
	customCalls(): number;
	screen(): string;
	sendInput(data: string): Promise<void>;
	waitForScreen(included: string, excluded?: string): Promise<void>;
	stop(): void;
}

function createTuiHarness(
	refresh: () => Promise<{ aborted: boolean; errors: Map<string, Error> }> = async () => ({
		aborted: false,
		errors: new Map(),
	}),
): TuiHarness {
	const terminal = new VirtualTerminal(90, 30);
	const tui: TUI = new TuiMainScreen(terminal);
	const editorContainer = new Container();
	const editor = new FakeEditor();
	const fakeMode = {
		editor,
		editorContainer,
		keybindings: new KeybindingsManager(),
		ui: tui,
		disposeActiveSelector: vi.fn(),
	};
	const showExtensionCustom = (InteractiveMode.prototype as unknown as { showExtensionCustom: ShowExtensionCustom })
		.showExtensionCustom;
	let customCallCount = 0;
	const custom = <T>(factory: CustomFactory<T>): Promise<T> => {
		customCallCount++;
		return showExtensionCustom.call(fakeMode, factory) as Promise<T>;
	};
	const unsupportedDialog = vi.fn(async () => undefined);
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: undefined,
		modelRegistry: {
			refresh: vi.fn(refresh),
		},
		ui: {
			custom,
			select: unsupportedDialog,
			input: unsupportedDialog,
			confirm: unsupportedDialog,
			notify: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;

	editorContainer.addChild(editor);
	tui.addChild(editorContainer);
	tui.setFocus(editor);
	tui.start();

	const screen = () => stripAnsi(editorContainer.children[0]?.render(90).join("\n") ?? "");
	return {
		ctx,
		editor,
		customCalls: () => customCallCount,
		screen,
		sendInput: async (data: string) => {
			await new Promise<void>((resolve) => {
				setImmediate(() => {
					terminal.sendInput(data);
					resolve();
				});
			});
			await terminal.waitForRender();
		},
		waitForScreen: async (included: string, excluded?: string) => {
			await vi.waitFor(() => {
				const output = screen();
				expect(output).toContain(included);
				if (excluded) expect(output).not.toContain(excluded);
			});
		},
		stop: () => tui.stop(),
	};
}

function extensionApi(): ExtensionAPI {
	return {
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
	} as unknown as ExtensionAPI;
}

describe("/router UI lifecycle", () => {
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

	function temporaryAgentDir(models: Array<{ id: string }> = [{ id: "worker" }]): string {
		const root = mkdtempSync(join(tmpdir(), "pi-router-ui-"));
		roots.push(root);
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = root;
		writeFileSync(
			join(root, "router.json"),
			`${JSON.stringify(
				{
					version: 1,
					relays: [
						{
							id: "alpha",
							baseUrl: "https://relay.example/v1",
							apiKey: "secret",
							models,
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		return root;
	}

	it("keeps deep menu navigation inside one custom lifecycle", async () => {
		temporaryAgentDir();
		const harness = createTuiHarness();
		try {
			const command = runRouterCommand("", harness.ctx, extensionApi());
			await harness.waitForScreen("API relays");
			harness.editor.renderCount = 0;

			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			expect(harness.editor.renderCount).toBe(0);

			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha · models");
			expect(harness.editor.renderCount).toBe(0);

			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha · worker");
			expect(harness.editor.renderCount).toBe(0);

			await harness.sendInput("\x1b[B");
			await harness.sendInput("\r");
			await harness.waitForScreen("Thinking · alpha / worker");
			expect(harness.editor.renderCount).toBe(0);

			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha · worker");
			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha · models");
			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			await harness.sendInput("\x1b");
			await harness.waitForScreen("API relays");
			expect(harness.editor.renderCount).toBe(0);
			expect(harness.customCalls()).toBe(1);

			await harness.sendInput("\x1b");
			await command;
			expect(harness.editor.renderCount).toBeGreaterThan(0);
		} finally {
			harness.stop();
		}
	});

	it("moves from catalog loading to its checklist and parent without mounting the editor", async () => {
		const root = temporaryAgentDir([]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "catalog-model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const harness = createTuiHarness();
		const pi = extensionApi();
		try {
			const command = runRouterCommand("alpha", harness.ctx, pi);
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha · models");
			harness.editor.renderCount = 0;

			await harness.sendInput("\r");
			await harness.waitForScreen("Select models · alpha");
			expect(harness.editor.renderCount).toBe(0);
			expect(harness.customCalls()).toBe(1);

			await harness.sendInput(" ");
			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha · models");
			expect(harness.editor.renderCount).toBe(0);
			expect(parseRouterFile(readFileSync(join(root, "router.json"), "utf8")).relays[0]?.models).toEqual([
				expect.objectContaining({ id: "catalog-model" }),
			]);
			expect(pi.registerProvider).toHaveBeenCalledWith("alpha", expect.anything());

			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			await harness.sendInput("\x1b");
			await command;
		} finally {
			applyRouterFile(pi, { version: 1, relays: [] });
			harness.stop();
		}
	});

	it("aborts an in-flight catalog request when leaving its loader", async () => {
		temporaryAgentDir([]);
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) throw new Error("probe fetch did not receive an AbortSignal");
			requestSignal = signal;
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		});
		const harness = createTuiHarness();
		try {
			const command = runRouterCommand("alpha", harness.ctx, extensionApi());
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha · models");
			harness.editor.renderCount = 0;

			await harness.sendInput("\r");
			await harness.waitForScreen("Fetching models · alpha");
			expect(requestSignal).toBeDefined();
			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha · models");
			expect(requestSignal?.aborted).toBe(true);
			expect(harness.editor.renderCount).toBe(0);

			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			await harness.sendInput("\x1b");
			await command;
		} finally {
			harness.stop();
		}
	});

	it("returns from internal input and confirmation pages without mounting the editor", async () => {
		temporaryAgentDir();
		const harness = createTuiHarness();
		try {
			const command = runRouterCommand("alpha", harness.ctx, extensionApi());
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			harness.editor.renderCount = 0;

			await harness.sendInput("\x1b[B");
			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha · base URL");
			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · base URL");
			expect(harness.editor.renderCount).toBe(0);

			for (let index = 0; index < 3; index++) await harness.sendInput("\x1b[B");
			await harness.sendInput("\r");
			await harness.waitForScreen('Remove relay "alpha"?');
			await harness.sendInput("\x1b");
			await harness.waitForScreen("Relay · alpha", 'Remove relay "alpha"?');
			expect(harness.editor.renderCount).toBe(0);
			expect(harness.customCalls()).toBe(1);
			expect(harness.ctx.ui.input).not.toHaveBeenCalled();
			expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();

			await harness.sendInput("\x1b");
			await command;
		} finally {
			harness.stop();
		}
	});

	it("moves between add-flow inputs without closing the custom root", async () => {
		const root = temporaryAgentDir([]);
		writeFileSync(join(root, "router.json"), `${JSON.stringify({ version: 1, relays: [] }, null, 2)}\n`);
		const harness = createTuiHarness();
		try {
			const command = runRouterCommand("add", harness.ctx, extensionApi());
			await harness.waitForScreen("New relay · name");
			harness.editor.renderCount = 0;

			await harness.sendInput("alpha");
			await harness.sendInput("\r");
			await harness.waitForScreen("New relay · alpha · base URL");
			expect(harness.editor.renderCount).toBe(0);
			expect(harness.customCalls()).toBe(1);

			await harness.sendInput("\x1b");
			await command;
			expect(harness.editor.renderCount).toBeGreaterThan(0);
		} finally {
			harness.stop();
		}
	});

	it("allows Esc to close while a confirmed change is still refreshing models", async () => {
		const root = temporaryAgentDir([]);
		let failRefresh: (error: Error) => void = () => {
			throw new Error("refresh rejector was not initialized");
		};
		const refresh = vi.fn(
			() =>
				new Promise<{ aborted: boolean; errors: Map<string, Error> }>((_resolve, reject) => {
					failRefresh = reject;
				}),
		);
		const harness = createTuiHarness(refresh);
		try {
			const command = runRouterCommand("alpha", harness.ctx, extensionApi());
			await harness.waitForScreen("Relay · alpha", "Relay · alpha · models");
			await harness.sendInput("\x1b[B");
			await harness.sendInput("\r");
			await harness.waitForScreen("Relay · alpha · base URL");
			harness.editor.renderCount = 0;

			await harness.sendInput("https://new.example/v1");
			await harness.sendInput("\r");
			await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
			expect(parseRouterFile(readFileSync(join(root, "router.json"), "utf8")).relays[0]?.baseUrl).toBe(
				"https://new.example/v1",
			);
			await harness.waitForScreen("Working…  Esc closes /router");
			expect(harness.editor.renderCount).toBe(0);

			await harness.sendInput("\x1b");
			await command;
			expect(harness.editor.renderCount).toBeGreaterThan(0);

			failRefresh(new Error("refresh failed after close"));
			await vi.waitFor(() =>
				expect(harness.ctx.ui.notify).toHaveBeenCalledWith("refresh failed after close", "error"),
			);
		} finally {
			harness.stop();
		}
	});

	it("keeps RPC dialogs on the native UI methods", async () => {
		temporaryAgentDir();
		let menuCalls = 0;
		const select = vi.fn(async (_title: string, options: string[]) => {
			menuCalls++;
			return menuCalls === 1 ? options.find((option) => option.startsWith("Base URL")) : undefined;
		});
		const input = vi.fn(async () => undefined);
		const custom = vi.fn();
		const ctx = {
			hasUI: true,
			mode: "rpc",
			model: undefined,
			modelRegistry: { refresh: vi.fn() },
			ui: { select, input, confirm: vi.fn(), custom, notify: vi.fn() },
		} as unknown as ExtensionCommandContext;

		await runRouterCommand("alpha", ctx, extensionApi());
		expect(select).toHaveBeenCalledTimes(2);
		expect(input).toHaveBeenCalledWith("Relay · alpha · base URL", "https://relay.example/v1");
		expect(custom).not.toHaveBeenCalled();
	});
});
