import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ROUTER_THINKING_LEVELS } from "../src/extensions/router/constants.ts";
import {
	createDefaultModelConfig,
	DEFAULT_THINKING_LEVEL_MAP,
	resolveModelConfig,
	resolveRouterThinkingMap,
	summarizeThinkingMap,
	toggleThinkingLevel,
} from "../src/extensions/router/presets.ts";

describe("router GPT thinking policy", () => {
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("defaults every new model to the conservative efforts", () => {
		const model = createDefaultModelConfig("gpt-5.6-sol");

		expect(model.thinkingLevelMap).toEqual(DEFAULT_THINKING_LEVEL_MAP);
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.thinkingLevelMap?.minimal).toBeNull();
		expect(ROUTER_THINKING_LEVELS).toHaveLength(7);
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("preserves legacy off/minimal values at runtime without mutating the stored map", () => {
		const stored = {
			off: "off",
			minimal: "minimal",
			low: null,
			medium: "medium",
			high: "high",
			xhigh: null,
			max: "max",
		} as const;
		const resolved = resolveRouterThinkingMap(stored);

		expect(stored.off).toBe("off");
		expect(stored.minimal).toBe("minimal");
		expect(resolved.off).toBe("off");
		expect(resolved.minimal).toBe("minimal");
		expect(resolved.low).toBeNull();
		expect(resolved.medium).toBe("medium");
		expect(resolved.xhigh).toBeNull();
	});

	it("caps only inherited output metadata for legacy small context models", () => {
		expect(resolveModelConfig({ id: "small", contextWindow: 32768 }).maxTokens).toBe(32768);
		expect(resolveModelConfig({ id: "small", contextWindow: 32768, maxTokens: 4096 }).maxTokens).toBe(4096);
	});

	it("keeps explicit visible-level choices when resolving a model", () => {
		const resolved = resolveModelConfig({
			id: "gpt-5.6-sol",
			thinkingLevelMap: { low: null, medium: "medium", high: null },
		});

		expect(resolved.thinkingLevelMap).toEqual({
			low: null,
			medium: "medium",
			high: null,
		});
		expect(summarizeThinkingMap({ low: null })).toBe("off, minimal, medium, high · hide low,xhigh,max");
	});

	it("summarizes all seven Pi levels", () => {
		const summary = summarizeThinkingMap({
			off: "off",
			minimal: "minimal",
			low: "low",
			medium: null,
			high: "high",
			xhigh: "xhigh",
			max: null,
		});

		expect(summary).toContain("low");
		expect(summary).toContain("hide medium,max");
		expect(summary).toContain("off");
		expect(summary).toContain("minimal");
	});

	it("toggles a level without changing other mappings", () => {
		const next = toggleThinkingLevel({ off: "off", minimal: "minimal", low: "low" }, "low");
		expect(next.low).toBeNull();
		expect(next.off).toBe("off");
		expect(next.minimal).toBe("minimal");
		expect(next.xhigh).toBeUndefined();
		expect(next.max).toBeUndefined();

		const reopened = toggleThinkingLevel(next, "low");
		expect(reopened.low).toBe("low");
	});
});
