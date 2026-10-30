import { type Component, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { openAgentSettings, readAgentSettings, resolveAgentConfiguration } from "../src/extensions/agent/settings.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createFakeTui } from "./suite/fake-tui.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

type UiStep = (component: Component) => void;
type UiComponent = Component & { dispose?(): void };
type UiFactory<T> = (
	tui: TUI,
	theme: Theme,
	keys: KeybindingsManager,
	done: (result: T) => void,
) => UiComponent | Promise<UiComponent>;
let harness: Harness;

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
});

function frame(component: Component, width = 100): string {
	return stripAnsi(component.render(width).join("\n"));
}

function input(component: Component, data: string): void {
	if (!component.handleInput) throw new Error("Expected an interactive selector");
	component.handleInput(data);
}

function action(label: string): UiStep {
	return (component) => {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (
				frame(component)
					.split("\n")
					.some((line) => line.startsWith(`› ${label}`))
			) {
				input(component, "\r");
				return;
			}
			input(component, "\x1b[B");
		}
		throw new Error(`Could not focus ${label}`);
	};
}

function pick(query: string): UiStep {
	return (component) => {
		for (const char of query) input(component, char);
		input(component, "\r");
	};
}

function cancel(component: Component): void {
	input(component, "\x1b");
}

function mouse(component: Component, type: "press" | "click", y: number): void {
	const event = { type, button: "left" as const, x: 2, y, screenX: 2, screenY: y, width: 80, height: 12 };
	component.handleMouse?.({ ...event, shift: false, alt: false, ctrl: false });
}

/** Drive real component input and observe rendered frames and persisted settings. */
function installUi(steps: UiStep[] = [], keys = new KeybindingsManager()) {
	setKeybindings(keys);
	const frames: string[] = [];
	const notify = vi.fn();
	const custom: ExtensionUIContext["custom"] = async <T>(factory: UiFactory<T>) => {
		let closed = false;
		let result: T | undefined;
		const tui = createFakeTui();
		const component = await factory(tui, theme, keys, (value) => {
			closed = true;
			result = value;
		});
		try {
			frames.push(frame(component));
			(steps.shift() ?? cancel)(component);
			if (!closed) throw new Error("UI step did not close the selector");
			return result as T;
		} finally {
			component.dispose?.();
		}
	};
	const runner = harness.session.extensionRunner;
	runner.setUIContext(createTestUiContext({ custom, notify }), "tui");
	return { ctx: runner.createCommandContext(), frames, notify };
}

async function maxSession(): Promise<void> {
	harness = await createHarness({
		models: [
			{ id: "main", reasoning: true },
			{ id: "worker", reasoning: true },
		],
	});
	await harness.session.setModel({ ...harness.models[0]!, thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
	harness.session.setThinkingLevel("max");
}

describe("Agent settings", () => {
	it("shows aligned inherited values and always offers the combined reset", async () => {
		harness = await createHarness({ models: [{ id: "main", reasoning: true }] });
		harness.session.setThinkingLevel("high");
		const { ctx, frames } = installUi();
		await openAgentSettings(ctx);
		expect(frames[0]).toContain("Agent Settings");
		expect(frames[0]).toMatch(/› Model\s+faux\/main · Follow current session/);
		expect(frames[0]).toMatch(/Effort\s+high · Follow current session/);
		expect(frames[0]).toContain("Reset to follow current session");
		expect(frames[0]).toContain("↑/↓ navigate · Enter change · Esc close");
		const modelRow = frames[0]!.split("\n").find((line) => line.startsWith("› Model"))!;
		const effortRow = frames[0]!.split("\n").find((line) => line.startsWith("  Effort"))!;
		expect(modelRow.indexOf("faux/main")).toBe(effortRow.indexOf("high"));
		expect(ctx.getExtensionSettings("agent")).toEqual({});
	});

	it.each([
		{ settings: { model: "faux/worker" }, modelFollows: false, effortFollows: true },
		{ settings: { thinking: "medium" }, modelFollows: true, effortFollows: false },
		{ settings: { model: "faux/worker", thinking: "medium" }, modelFollows: false, effortFollows: false },
	])("labels each field's inheritance independently: $settings", async ({ settings, modelFollows, effortFollows }) => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "worker", reasoning: true },
			],
		});
		const { ctx, frames } = installUi();
		await ctx.setExtensionSettings("agent", settings);
		await openAgentSettings(ctx);
		const rows = frames[0]!.split("\n");
		expect(rows.find((line) => line.startsWith("› Model"))!.includes("Follow current session")).toBe(modelFollows);
		expect(rows.find((line) => line.startsWith("  Effort"))!.includes("Follow current session")).toBe(effortFollows);
	});

	it.each([true, false])(
		"shows the effective inherited thinking level and preserves the request (follow=%s)",
		async (following) => {
			await maxSession();
			const { ctx, frames } = installUi();
			const saved = { model: "faux/worker", ...(following ? {} : { thinking: "max" }) };
			await ctx.setExtensionSettings("agent", saved);
			await openAgentSettings(ctx);
			const effortRow = frames[0]!.split("\n").find((line) => line.startsWith("  Effort"))!;
			expect(effortRow).toMatch(/Effort\s+max → high/);
			expect(effortRow.includes("Follow current session")).toBe(following);
			expect(resolveAgentConfiguration(ctx).thinking).toBe("high");
			expect(harness.session.thinkingLevel).toBe("max");
			expect(ctx.getExtensionSettings("agent")).toEqual(saved);
		},
	);

	it("reuses scoped model search without switching the parent or saving global defaults", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker" }] });
		harness.session.setScopedModels([{ model: harness.models[1]! }]);
		const { ctx, frames } = installUi([
			action("Model"),
			(component) => {
				expect(frame(component)).toContain("worker [faux]");
				expect(frame(component)).not.toContain("main [faux]");
				expect(frame(component)).not.toContain("set as default");
				input(component, "\x13");
				input(component, "\t");
				expect(frame(component)).toContain("main [faux]");
				pick("worker")(component);
			},
		]);
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({ model: "faux/worker" });
		expect(frames.at(-1)).toMatch(/› Model\s+faux\/worker\s*\n/);
		expect(harness.session.model?.id).toBe("main");
		expect(harness.settingsManager.getDefaultModel()).toBeUndefined();
		expect(harness.session.scopedModels.map((entry) => entry.model.id)).toEqual(["worker"]);
	});

	it("reuses supported thinking search and saves only an Agent effort override", async () => {
		await maxSession();
		const { ctx, frames } = installUi([
			action("Effort"),
			(component) => {
				const output = frame(component);
				expect(output).toContain("Thinking Level");
				expect(output).toMatch(/→ ✓ high/);
				expect(output).not.toMatch(/^\s*[→✓ ]*max\s/m);
				expect(output).not.toContain("set as default");
				expect(output).not.toContain("in-session");
				input(component, "\x13");
				pick("medium")(component);
			},
		]);
		await ctx.setExtensionSettings("agent", { model: "faux/worker" });
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({ model: "faux/worker", thinking: "medium" });
		expect(frames.at(-1)).toMatch(/› Effort\s+medium\s*\n/);
		expect(harness.session.thinkingLevel).toBe("max");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBeUndefined();
	});

	it("makes an explicit choice fixed even when it equals the inherited effective level", async () => {
		await maxSession();
		const { ctx } = installUi([action("Effort"), pick("high")]);
		await ctx.setExtensionSettings("agent", { model: "faux/worker" });
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({ model: "faux/worker", thinking: "high" });
		harness.session.setThinkingLevel("low");
		expect(resolveAgentConfiguration(ctx).thinking).toBe("high");
	});

	it("resets both overrides in one write and preserves unrelated settings", async () => {
		await maxSession();
		const { ctx, frames } = installUi([action("Reset to follow current session")]);
		await ctx.setExtensionSettings("agent", { model: "faux/worker", thinking: "high", retain: true });
		await ctx.setExtensionSettings("other", { preserve: 42 });
		const save = vi.spyOn(harness.settingsManager, "setExtensionSettings");
		await openAgentSettings(ctx);
		expect(save).toHaveBeenCalledExactlyOnceWith("agent", { retain: true });
		expect(ctx.getExtensionSettings("other")).toEqual({ preserve: 42 });
		expect(readAgentSettings(ctx)).toEqual({});
		expect(resolveAgentConfiguration(ctx).model.id).toBe("main");
		expect(resolveAgentConfiguration(ctx).thinking).toBe("max");
		expect(frames.at(-1)).toMatch(/Model\s+faux\/main · Follow current session/);
		expect(frames.at(-1)).toMatch(/Effort\s+max · Follow current session/);
		expect(frames.at(-1)).toContain("› Reset to follow current session");

		const again = installUi([action("Reset to follow current session")]);
		await openAgentSettings(again.ctx);
		expect(save).toHaveBeenCalledOnce();
	});

	it("does not mutate malformed settings when cancelling either picker", async () => {
		harness = await createHarness();
		const { ctx, frames } = installUi([action("Model"), cancel, action("Effort"), cancel]);
		const saved = { model: "gpt-4o", thinking: "impossible", preserve: 42 };
		await ctx.setExtensionSettings("agent", saved);
		const save = vi.spyOn(harness.settingsManager, "setExtensionSettings");
		await openAgentSettings(ctx);
		expect(frames[0]).toMatch(/Model\s+gpt-4o \[invalid\]/);
		expect(frames[0]).toMatch(/Effort\s+impossible \[invalid\]/);
		expect(save).not.toHaveBeenCalled();
		expect(ctx.getExtensionSettings("agent")).toEqual(saved);
	});

	it("repairs an invalid model choice without changing the other fields", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker", reasoning: true }] });
		const { ctx } = installUi([action("Model"), pick("worker")]);
		await ctx.setExtensionSettings("agent", { model: "gpt-4o", thinking: "high", retain: "yes" });
		expect(() => resolveAgentConfiguration(ctx)).toThrow("Invalid Agent model setting");
		await openAgentSettings(ctx);
		expect(ctx.getExtensionSettings("agent")).toEqual({ model: "faux/worker", thinking: "high", retain: "yes" });
		expect(resolveAgentConfiguration(ctx).model.id).toBe("worker");
	});

	it("repairs an invalid effort choice without changing the model or other fields", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "worker", reasoning: true }] });
		const { ctx } = installUi([action("Effort"), pick("high")]);
		await ctx.setExtensionSettings("agent", { model: "faux/worker", thinking: "impossible", customFlag: true });
		expect(() => readAgentSettings(ctx)).toThrow("Invalid Agent effort setting");
		await openAgentSettings(ctx);
		expect(ctx.getExtensionSettings("agent")).toEqual({ model: "faux/worker", thinking: "high", customFlag: true });
	});

	it.each([
		{ model: 123, thinking: true, modelLabel: "123 [invalid]", effortLabel: "true [invalid]" },
		{
			model: "x".repeat(2000),
			thinking: { invalid: "x".repeat(2000) },
			modelLabel: "[invalid]",
			effortLabel: "[invalid]",
		},
	])("keeps invalid indicators bounded and resets both damaged fields: $modelLabel", async (stored) => {
		harness = await createHarness();
		const { ctx, frames } = installUi([action("Reset to follow current session")]);
		await ctx.setExtensionSettings("agent", { model: stored.model, thinking: stored.thinking, keep: "yes" });
		await openAgentSettings(ctx);
		expect(frames[0]).toContain(stored.modelLabel);
		expect(frames[0]).toContain(stored.effortLabel);
		expect(frames[0]).not.toContain("x".repeat(100));
		expect(ctx.getExtensionSettings("agent")).toEqual({ keep: "yes" });
	});

	it("does not substitute parent capabilities when the configured model is unavailable", async () => {
		await maxSession();
		const { ctx, frames } = installUi();
		const saved = { model: "missing/model", thinking: "max" };
		await ctx.setExtensionSettings("agent", saved);
		await openAgentSettings(ctx);
		expect(frames[0]).toContain("missing/model [unavailable]");
		expect(frames[0]).toMatch(/Effort\s+max \[unresolved\]/);
		expect(() => resolveAgentConfiguration(ctx)).toThrow("Agent model is unavailable: missing/model");
		expect(ctx.getExtensionSettings("agent")).toEqual(saved);
	});

	it("fits narrow terminals and keeps unavailable markers ahead of long model names", async () => {
		harness = await createHarness();
		const { ctx } = installUi([
			(component) => {
				for (const width of [0, 1, 8, 24, 40, 80, 120]) {
					expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
				}
				expect(frame(component, 40)).toContain("[unavailable]");
				cancel(component);
			},
		]);
		await ctx.setExtensionSettings("agent", { model: `missing/${"模型🙂".repeat(100)}` });
		await openAgentSettings(ctx);
	});

	it("keeps the inheritance marker readable on narrow terminals", async () => {
		harness = await createHarness({ models: [{ id: "a-rather-long-model-identifier", reasoning: true }] });
		harness.session.setThinkingLevel("high");
		const { ctx } = installUi([
			(component) => {
				expect(frame(component, 120)).toContain("· Follow current session");
				expect(frame(component, 40)).toContain("· follow");
				expect(frame(component, 40)).not.toContain("Follow current session");
				expect(frame(component, 30)).toContain("· follow");
				cancel(component);
			},
		]);
		await openAgentSettings(ctx);
	});

	it("selects rows with the mouse without drifting from the layout", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "worker", reasoning: true },
			],
		});
		const { ctx, frames } = installUi([
			(component) => {
				mouse(component, "press", 4);
				expect(frame(component)).toMatch(/› Effort/);
				mouse(component, "click", 3);
				expect(frame(component)).toMatch(/› Effort/);
				cancel(component);
			},
		]);
		await openAgentSettings(ctx);
		expect(frames[0]).toMatch(/› Model/);
	});

	it("opens a picker when a row is clicked", async () => {
		harness = await createHarness({
			models: [
				{ id: "main", reasoning: true },
				{ id: "worker", reasoning: true },
			],
		});
		const { ctx } = installUi([(component) => mouse(component, "click", 2), pick("worker")]);
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({ model: "faux/worker" });
	});

	it("uses configured keys for both navigation and compact hints", async () => {
		harness = await createHarness();
		const keys = new KeybindingsManager({
			"tui.select.up": "ctrl+p",
			"tui.select.down": "ctrl+n",
			"tui.select.confirm": "ctrl+x",
			"tui.select.cancel": "ctrl+g",
		});
		const { ctx } = installUi(
			[
				(component) => {
					expect(frame(component)).toContain("Ctrl+P/Ctrl+N navigate · Ctrl+X change · Ctrl+G close");
					input(component, "\x0e");
					expect(frame(component)).toMatch(/› Effort/);
					input(component, "\x18");
				},
				(component) => input(component, "\x07"),
				(component) => input(component, "\x07"),
			],
			keys,
		);
		await openAgentSettings(ctx);
		expect(readAgentSettings(ctx)).toEqual({});
	});

	it.each(["Model", "Effort", "Reset to follow current session"])(
		"reports failed persistence without claiming success: %s",
		async (label) => {
			harness = await createHarness({
				models: [
					{ id: "main", reasoning: true },
					{ id: "worker", reasoning: true },
				],
			});
			const steps = [
				action(label),
				...(label === "Model" ? [pick("worker")] : label === "Effort" ? [pick("high")] : []),
			];
			const { ctx, notify } = installUi(steps);
			const saved = { model: "faux/main", thinking: "low", keep: true };
			await ctx.setExtensionSettings("agent", saved);
			vi.spyOn(harness.settingsManager, "setExtensionSettings").mockRejectedValueOnce(new Error("Disk unavailable"));
			await openAgentSettings(ctx);
			expect(notify).toHaveBeenCalledExactlyOnceWith("Could not save Agent settings: Disk unavailable", "error");
			expect(ctx.getExtensionSettings("agent")).toEqual(saved);
		},
	);

	it("does not open a panel or overwrite broken settings storage", async () => {
		harness = await createHarness();
		const { ctx, frames, notify } = installUi();
		vi.spyOn(harness.settingsManager, "getExtensionSettings").mockImplementationOnce(() => {
			throw new Error("Invalid extension settings object");
		});
		await openAgentSettings(ctx);
		expect(notify).toHaveBeenCalledWith("Invalid extension settings object", "error");
		expect(frames).toEqual([]);
	});

	it("rejects malformed or unavailable saved configuration instead of falling back", async () => {
		harness = await createHarness();
		const ctx = harness.session.extensionRunner.createContext();
		await ctx.setExtensionSettings("agent", { model: "missing/model" });
		expect(() => resolveAgentConfiguration(ctx)).toThrow("Agent model is unavailable: missing/model");
		await ctx.setExtensionSettings("agent", { thinking: "impossible" });
		expect(() => readAgentSettings(ctx)).toThrow("Invalid Agent effort setting");
	});

	it("rejects a captured settings context after its session is disposed", async () => {
		harness = await createHarness();
		const ctx = harness.session.extensionRunner.createContext();
		harness.session.dispose();
		expect(() => ctx.getExtensionSettings("agent")).toThrow(/stale/);
		expect(() => ctx.setExtensionSettings("agent", {})).toThrow(/stale/);
	});

	it("reports errors and valid settings without opening TUI in non-interactive modes", async () => {
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
		expect(notify).toHaveBeenCalledWith("Agent model: faux/main · Effort: high", "info");
	});
});
