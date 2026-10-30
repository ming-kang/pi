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

	it("recovers from invalid model setting by selecting a valid model or resetting inheritance, preserving other keys", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker" }] });
		const runner = harness.session.extensionRunner;
		const choice = `${harness.models[1]!.provider}/${harness.models[1]!.id}`;
		const custom = vi.fn().mockResolvedValueOnce(harness.models[1]!);
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => {
				expect(options[0]).toContain("Model · gpt-4o [invalid]");
				expect(options).toContain("Reset model to follow current session");
				return Promise.resolve(options[0]);
			})
			.mockImplementationOnce((_title, options) => {
				expect(options[0]).toContain(`Model · ${choice}`);
				return Promise.resolve("Reset model to follow current session");
			})
			.mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), custom, select, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: "gpt-4o", retain: "yes" });
		await ctx.setExtensionSettings("other", { untouched: 1 });

		expect(() => readAgentSettings(ctx)).toThrow("Invalid Agent model setting. Choose a model with /agent.");
		expect(() => resolveAgentConfiguration(ctx)).toThrow("Invalid Agent model setting. Choose a model with /agent.");

		await openAgentSettings(ctx);

		expect(select).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(`Agent model: ${choice}`, "info");
		expect(notify).toHaveBeenCalledWith("Agent model: Follow current session", "info");
		expect(ctx.getExtensionSettings("agent")).toEqual({ retain: "yes" });
		expect(ctx.getExtensionSettings("other")).toEqual({ untouched: 1 });
		expect(readAgentSettings(ctx)).toEqual({});
	});

	it("recovers from invalid thinking setting by selecting a valid level or resetting inheritance, preserving other keys", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker", reasoning: true }] });
		const runner = harness.session.extensionRunner;
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => {
				expect(options[1]).toContain("Thinking · impossible [invalid]");
				expect(options).toContain("Reset thinking to follow current session");
				return Promise.resolve(options[1]);
			})
			.mockImplementationOnce((_title, options) => {
				expect(options).toContain("Follow current session");
				expect(options).toContain("high");
				return Promise.resolve("high");
			})
			.mockImplementationOnce((_title, options) => {
				expect(options[1]).toContain("Thinking · high");
				return Promise.resolve("Reset thinking to follow current session");
			})
			.mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), select, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: "faux/worker", thinking: "impossible", customFlag: true });

		expect(() => readAgentSettings(ctx)).toThrow(
			"Invalid Agent thinking setting. Choose a thinking level with /agent.",
		);
		expect(() => resolveAgentConfiguration(ctx)).toThrow(
			"Invalid Agent thinking setting. Choose a thinking level with /agent.",
		);

		await openAgentSettings(ctx);

		expect(select).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Agent thinking: high", "info");
		expect(notify).toHaveBeenCalledWith("Agent thinking: Follow current session", "info");
		expect(ctx.getExtensionSettings("agent")).toEqual({ model: "faux/worker", customFlag: true });
		expect(readAgentSettings(ctx)).toEqual({ model: "faux/worker" });
	});

	it("allows resetting thinking when the configured model is unavailable", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => {
				expect(options[0]).toContain("Model · missing/model [unavailable]");
				expect(options[1]).toContain("Thinking · high");
				return Promise.resolve(options[1]);
			})
			.mockImplementationOnce((_title, options) => {
				expect(options).toContain("Follow current session");
				return Promise.resolve("Follow current session");
			})
			.mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), select, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: "missing/model", thinking: "high" });

		expect(() => resolveAgentConfiguration(ctx)).toThrow("Agent model is unavailable: missing/model");

		await openAgentSettings(ctx);

		expect(notify).toHaveBeenCalledWith("Agent thinking: Follow current session", "info");
		expect(ctx.getExtensionSettings("agent")).toEqual({ model: "missing/model" });
		expect(readAgentSettings(ctx)).toEqual({ model: "missing/model" });
		expect(() => resolveAgentConfiguration(ctx)).toThrow("Agent model is unavailable: missing/model");
	});

	it("does not mutate invalid settings on Escape", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const custom = vi.fn().mockResolvedValueOnce(undefined);
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => Promise.resolve(options[0]))
			.mockImplementationOnce((_title, options) => Promise.resolve(options[1]))
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), custom, select, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: "gpt-4o", thinking: "impossible", preserve: 42 });
		const saveSpy = vi.spyOn(harness.settingsManager, "setExtensionSettings");

		await openAgentSettings(ctx);

		expect(select).toHaveBeenCalled();
		expect(custom).toHaveBeenCalled();
		expect(saveSpy).not.toHaveBeenCalled();
		expect(ctx.getExtensionSettings("agent")).toEqual({ model: "gpt-4o", thinking: "impossible", preserve: 42 });
	});

	it("reports persistence errors when repairing invalid settings without claiming success", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const select = vi
			.fn()
			.mockImplementationOnce((_title, _options) => Promise.resolve("Reset model to follow current session"))
			.mockResolvedValueOnce(undefined);
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), select, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: "gpt-4o" });
		vi.spyOn(harness.settingsManager, "setExtensionSettings").mockRejectedValueOnce(new Error("Disk full"));

		await openAgentSettings(ctx);

		expect(notify).toHaveBeenCalledWith("Could not save Agent settings: Disk full", "error");
		expect(ctx.getExtensionSettings("agent")).toEqual({ model: "gpt-4o" });
	});

	it("reports non-destructive error when getExtensionSettings throws from broken storage", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const select = vi.fn();
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), select, notify }, "tui");
		const ctx = runner.createCommandContext();
		vi.spyOn(harness.settingsManager, "getExtensionSettings").mockImplementationOnce(() => {
			throw new Error("Invalid extension settings object");
		});

		await openAgentSettings(ctx);

		expect(notify).toHaveBeenCalledWith("Invalid extension settings object", "error");
		expect(select).not.toHaveBeenCalled();
	});

	it("notifies errors in non-tui mode on invalid settings and announces valid settings", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), notify }, "print");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: "invalid-bare-model" });

		await openAgentSettings(ctx);
		expect(notify).toHaveBeenCalledWith("Invalid Agent model setting. Choose a model with /agent.", "error");

		notify.mockClear();
		await ctx.setExtensionSettings("agent", { model: "faux/main", thinking: "high" });
		await openAgentSettings(ctx);
		expect(notify).toHaveBeenCalledWith("Agent model: faux/main · Thinking: high", "info");
	});

	it("keeps invalid-setting indicators visible without echoing oversized values", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		let labels: string[] = [];
		const select = vi.fn().mockImplementation(async (_title, options) => {
			labels = options;
			return undefined;
		});
		runner.setUIContext({ ...runner.getUIContext(), select }, "tui");
		const ctx = runner.createCommandContext();
		const stored = { model: "x".repeat(2000), thinking: { invalid: "x".repeat(2000) } };
		await ctx.setExtensionSettings("agent", stored);
		await openAgentSettings(ctx);
		expect(labels[0]).toBe("Model · [invalid]");
		expect(labels[1]).toBe("Thinking · [invalid]");
		expect(ctx.getExtensionSettings("agent")).toEqual(stored);
	});

	it("formats edge-case invalid types and supports resetting both invalid fields sequentially", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const select = vi
			.fn()
			.mockImplementationOnce((_title, options) => {
				expect(options[0]).toContain("Model · 123 [invalid]");
				expect(options[1]).toContain("Thinking · true [invalid]");
				expect(options).toContain("Reset model to follow current session");
				expect(options).toContain("Reset thinking to follow current session");
				return Promise.resolve("Reset thinking to follow current session");
			})
			.mockImplementationOnce((_title, options) => {
				expect(options[0]).toContain("Model · 123 [invalid]");
				expect(options[1]).toContain("Follow current session");
				expect(options).toContain("Reset model to follow current session");
				expect(options).not.toContain("Reset thinking to follow current session");
				return Promise.resolve("Reset model to follow current session");
			})
			.mockImplementationOnce((_title, options) => {
				expect(options[0]).toContain("Follow current session");
				expect(options[1]).toContain("Follow current session");
				expect(options).not.toContain("Reset model to follow current session");
				expect(options).not.toContain("Reset thinking to follow current session");
				return Promise.resolve(undefined);
			});
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), select, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("agent", { model: 123, thinking: true, preservedKey: "keep-me" });

		await openAgentSettings(ctx);

		expect(ctx.getExtensionSettings("agent")).toEqual({ preservedKey: "keep-me" });
		expect(readAgentSettings(ctx)).toEqual({});
	});
});
