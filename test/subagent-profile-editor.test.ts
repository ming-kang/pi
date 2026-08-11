import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AgentDefinition, SubagentProfileOverride } from "../src/extensions/subagent/types.ts";
import { ProfileEditorComponent, type ProfileEditorResult } from "../src/extensions/subagent/ui/profile-editor.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function model(provider: string, id: string, reasoning = true): Model<Api> {
	return {
		id,
		name: `${id} display name`,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

const explorerDescription =
	"Fast read-only agent for finding files, searching code, and answering codebase questions without changing files.";
const explorer: AgentDefinition = {
	name: "explorer",
	description: explorerDescription,
	tools: ["read"],
	systemPrompt: "Explore",
	source: "builtin",
	filePath: "<builtin:explorer>",
	backend: "sdk",
};

function fakeTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI;
}

function createEditor(
	options: {
		models?: Model<Api>[];
		scopedModels?: Array<{ model: Model<Api> }>;
		currentModel?: Model<Api>;
		currentThinking?: ThinkingLevel;
		override?: SubagentProfileOverride;
		keybindings?: KeybindingsManager;
		onDone?: (result: ProfileEditorResult | undefined) => void;
	} = {},
): ProfileEditorComponent {
	const models = options.models ?? [model("anthropic", "sonnet")];
	return new ProfileEditorComponent({
		tui: fakeTui(),
		theme,
		keybindings: options.keybindings ?? new KeybindingsManager(),
		agent: explorer,
		override: options.override,
		models,
		scopedModels: options.scopedModels ?? [],
		currentSessionModel: options.currentModel ?? models[0],
		currentThinking: options.currentThinking ?? "high",
		onDone: options.onDone ?? (() => {}),
	});
}

function render(editor: ProfileEditorComponent, width = 120): string {
	return stripAnsi(editor.render(width).join("\n"));
}

describe("Subagent profile editor", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("shows the display name, inherited values, and complete naturally wrapped description", () => {
		const editor = createEditor();
		const lines = editor.render(38);
		const output = stripAnsi(lines.join("\n"));
		expect(output).toContain("Explorer");
		expect(output).toContain("inherit (anthropic/sonnet)");
		expect(output).toContain("Thinking");
		expect(output.replace(/\s+/gu, " ")).toContain(explorerDescription);
		expect(lines.every((line) => visibleWidth(line) <= 38)).toBe(true);
	});

	it("applies the highlighted model and cycled thinking level together", () => {
		let result: ProfileEditorResult | undefined;
		const editor = createEditor({
			onDone: (value) => {
				result = value;
			},
		});
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[Z");
		editor.handleInput("\r");
		expect(result).toEqual({ model: "anthropic/sonnet", thinking: "off" });
	});

	it("uses the configured thinking-cycle key", () => {
		let result: ProfileEditorResult | undefined;
		const keybindings = new KeybindingsManager({ "app.thinking.cycle": ["ctrl+y"] });
		const editor = createEditor({
			keybindings,
			onDone: (value) => {
				result = value;
			},
		});
		editor.handleInput("\x1b[B");
		editor.handleInput("\x19");
		editor.handleInput("\r");
		expect(result).toEqual({ model: "anthropic/sonnet", thinking: "off" });
	});

	it("limits thinking choices to the highlighted model's capabilities", () => {
		const editor = createEditor({
			models: [model("plain", "chat", false)],
			currentModel: model("anthropic", "parent"),
		});
		editor.handleInput("\x1b[B");
		const output = render(editor);
		expect(output).toContain("Thinking");
		expect(output).toContain("off");
		expect(output).not.toContain("medium");
		expect(output).not.toContain("xhigh");
	});

	it("defaults to scoped models and toggles to all models with Tab", () => {
		const alpha = model("provider", "alpha");
		const beta = model("provider", "beta");
		const editor = createEditor({ models: [alpha, beta], scopedModels: [{ model: beta }], currentModel: alpha });
		let output = render(editor);
		expect(output).toContain("Scope: all | scoped");
		expect(output).toContain("beta [provider]");
		expect(output).not.toContain("alpha [provider]");

		editor.handleInput("\t");
		output = render(editor);
		expect(output).toContain("alpha [provider]");
		expect(output).toContain("beta [provider]");
	});

	it("keeps a saved model visible when it falls outside the active scope", () => {
		const alpha = model("provider", "alpha");
		const beta = model("provider", "beta");
		const editor = createEditor({
			models: [alpha, beta],
			scopedModels: [{ model: beta }],
			override: { model: "provider/alpha" },
		});
		const output = render(editor);
		expect(output).toContain("alpha [provider] ✓");
		expect(output).not.toContain("alpha [provider · unavailable]");
	});

	it("keeps an unavailable saved override visible", () => {
		const editor = createEditor({ override: { model: "missing/retired", thinking: "medium" } });
		const output = render(editor);
		expect(output).toContain("retired [missing · unavailable] ✓");
	});

	it("preserves the selected model when refreshed models arrive", () => {
		const sonnet = model("anthropic", "sonnet");
		const editor = createEditor({ models: [sonnet] });
		editor.handleInput("\x1b[B");
		editor.updateModels([model("anthropic", "haiku"), sonnet]);
		const output = render(editor);
		expect(output).toContain("→ sonnet [anthropic]");
	});

	it("cancels without returning a draft and aborts refresh", () => {
		let result: ProfileEditorResult | undefined = { model: "sentinel", thinking: "off" };
		const editor = createEditor({
			onDone: (value) => {
				result = value;
			},
		});
		editor.handleInput("\x1b");
		expect(result).toBeUndefined();
		expect(editor.refreshSignal.aborted).toBe(true);
	});
});
