import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { openAgentSettings, readAgentSettings, resolveAgentConfiguration } from "../src/extensions/agent/settings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness;
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
});

describe("Agent settings", () => {
	it("saves model and thinking overrides for future Agents and restores inheritance", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker" }] });
		const runner = harness.session.extensionRunner;
		const choice = `${harness.models[1]!.provider}/${harness.models[1]!.id}`;
		const custom = vi.fn().mockResolvedValueOnce(harness.models[1]!);
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => Promise.resolve(options[0]))
			.mockImplementationOnce((_title, options) => Promise.resolve(options[1]))
			.mockResolvedValueOnce("high")
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce((_title, options) => Promise.resolve(options[2]))
			.mockImplementationOnce((_title, options) => Promise.resolve(options[1]))
			.mockResolvedValueOnce("Follow current session")
			.mockResolvedValue(undefined);
		runner.setUIContext({ ...runner.getUIContext(), custom, select, notify: vi.fn() }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("other", { preserve: true });
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({ model: choice, thinking: "high" });
		expect(resolveAgentConfiguration(ctx).model.id).toBe("worker");
		expect(harness.session.model?.id).toBe("main");
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({});
		expect(ctx.getExtensionSettings("other")).toEqual({ preserve: true });
	});

	it("does not save on Escape and reports failed persistence", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const custom = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(harness.models[0]!);
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => Promise.resolve(options[0]))
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce((_title, options) => Promise.resolve(options[0]))
			.mockResolvedValue(undefined);
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), custom, select, notify }, "tui");
		const ctx = runner.createCommandContext();
		const save = vi.spyOn(harness.settingsManager, "setExtensionSettings");
		await openAgentSettings(ctx);
		expect(save).not.toHaveBeenCalled();
		save.mockRejectedValue(new Error("Disk unavailable"));
		await openAgentSettings(ctx);
		expect(notify).toHaveBeenCalledWith("Could not save Agent settings: Disk unavailable", "error");
	});

	it("uses the native scoped model selector instead of flattening the full catalog", async () => {
		initTheme("dark");
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker" }] });
		harness.session.setScopedModels([{ model: harness.models[1]! }]);
		const runner = harness.session.extensionRunner;
		const custom = vi.fn().mockImplementation(async (factory) => {
			const component = await factory(
				{ requestRender: vi.fn() } as unknown as TUI,
				theme,
				new KeybindingsManager(),
				() => {},
			);
			expect(component).toBeInstanceOf(ModelSelectorComponent);
			const frame = component.render(100).join("\n");
			expect(frame).toContain("worker");
			expect(frame).not.toContain("main [");
			component.dispose();
			return undefined;
		});
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => Promise.resolve(options[0]))
			.mockResolvedValueOnce(undefined);
		runner.setUIContext({ ...runner.getUIContext(), custom, select }, "tui");
		await openAgentSettings(runner.createCommandContext());
		expect(custom).toHaveBeenCalledOnce();
	});

	it("rejects malformed or unavailable saved configuration instead of falling back", async () => {
		harness = await createHarness();
		const ctx = harness.session.extensionRunner.createContext();
		await ctx.setExtensionSettings("agent", { model: "missing/model" });
		expect(() => resolveAgentConfiguration(ctx)).toThrow("Agent model is unavailable: missing/model");
		await ctx.setExtensionSettings("agent", { thinking: "impossible" });
		expect(() => readAgentSettings(ctx)).toThrow("Invalid Agent thinking setting");
	});

	it("rejects a captured settings context after its session is disposed", async () => {
		harness = await createHarness();
		const ctx = harness.session.extensionRunner.createContext();
		harness.session.dispose();
		expect(() => ctx.getExtensionSettings("agent")).toThrow(/stale/);
		expect(() => ctx.setExtensionSettings("agent", {})).toThrow(/stale/);
	});
});
