import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type ProfileModelChoice, ProfileModelListComponent } from "../src/extensions/subagent/ui/model-list.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: `${id} display name`,
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

function createList(
	options: {
		models?: Model<Api>[];
		scopedModels?: Array<{ model: Model<Api> }>;
		currentModel?: Model<Api>;
		savedModelId?: string;
		onDone?: (choice: ProfileModelChoice | undefined) => void;
	} = {},
): ProfileModelListComponent {
	const models = options.models ?? [model("provider", "alpha"), model("provider", "beta")];
	return new ProfileModelListComponent({
		theme,
		keybindings: new KeybindingsManager(),
		models,
		scopedModels: options.scopedModels ?? [],
		currentSessionModel: options.currentModel ?? models[0],
		savedModelId: options.savedModelId,
		onDone: options.onDone ?? (() => {}),
	});
}

function render(list: ProfileModelListComponent): string {
	return stripAnsi(list.render(100).join("\n"));
}

describe("Subagent profile model list", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("searches configured models and confirms the highlighted choice", () => {
		const onDone = vi.fn();
		const list = createList({ onDone });
		list.handleInput("b");
		list.handleInput("e");
		list.handleInput("t");
		expect(render(list)).toContain("beta [provider]");
		expect(render(list)).not.toContain("alpha [provider]");
		list.handleInput("\r");
		expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ modelId: "provider/beta", unavailable: false }));
	});

	it("keeps the picker open when confirming an empty search result", () => {
		const onDone = vi.fn();
		const list = createList({ onDone });
		for (const character of "zzzz") list.handleInput(character);
		expect(render(list)).toContain("No matching models");

		list.handleInput("\r");

		expect(onDone).not.toHaveBeenCalled();
		expect(list.getSearchValue()).toBe("zzzz");
		expect(render(list)).toContain("No matching models");
	});

	it("defaults to the scoped set and toggles to all models", () => {
		const alpha = model("provider", "alpha");
		const beta = model("provider", "beta");
		const list = createList({ models: [alpha, beta], scopedModels: [{ model: beta }], currentModel: alpha });
		expect(render(list)).toContain("beta [provider]");
		expect(render(list)).not.toContain("alpha [provider]");
		list.handleInput("\t");
		expect(render(list)).toContain("alpha [provider]");
		expect(render(list)).toContain("beta [provider]");
	});

	it("keeps unavailable saved overrides visible and preserves selection after refresh", () => {
		const list = createList({ savedModelId: "missing/retired" });
		expect(render(list)).toContain("retired [missing · unavailable] ✓");
		list.updateModels([model("provider", "gamma")]);
		expect(render(list)).toContain("→ retired [missing · unavailable] ✓");
	});

	it("distinguishes choosing inherit from dismissing the picker", () => {
		const choose = vi.fn();
		const inherit = createList({ savedModelId: undefined, onDone: choose });
		inherit.handleInput("\r");
		expect(choose).toHaveBeenCalledWith(expect.objectContaining({ modelId: undefined, unavailable: false }));

		const dismiss = vi.fn();
		const cancelled = createList({ onDone: dismiss });
		cancelled.handleInput("\x1b");
		expect(dismiss).toHaveBeenCalledWith(undefined);
	});
});
