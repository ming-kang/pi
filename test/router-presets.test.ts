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

	it("defaults every new model to the five visible levels", () => {
		const model = createDefaultModelConfig("gpt-5.6-sol");

		expect(model.thinkingLevelMap).toEqual(DEFAULT_THINKING_LEVEL_MAP);
		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.thinkingLevelMap?.minimal).toBeNull();
		for (const level of ROUTER_THINKING_LEVELS) {
			expect(model.thinkingLevelMap?.[level]).toBe(level);
		}
	});

	it("hides legacy off/minimal values at runtime without mutating the stored map", () => {
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
		expect(resolved.off).toBeNull();
		expect(resolved.minimal).toBeNull();
		expect(resolved.low).toBeNull();
		expect(resolved.medium).toBe("medium");
		expect(resolved.xhigh).toBeNull();
	});

	it("keeps explicit visible-level choices when resolving a model", () => {
		const resolved = resolveModelConfig({
			id: "gpt-5.6-sol",
			thinkingLevelMap: { low: null, medium: "medium", high: null },
		});

		expect(resolved.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: "max",
		});
		expect(summarizeThinkingMap({ low: null })).toBe("medium, high, xhigh, max · hide low");
	});

	it("summarizes only the five router levels", () => {
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
		expect(summary).not.toContain("off");
		expect(summary).not.toContain("minimal");
	});

	it("toggles visible levels while keeping off/minimal disabled", () => {
		const next = toggleThinkingLevel({ off: "off", minimal: "minimal", low: "low" }, "low");
		expect(next.low).toBeNull();
		expect(next.off).toBeNull();
		expect(next.minimal).toBeNull();
		expect(next.xhigh).toBe("xhigh");
		expect(next.max).toBe("max");

		const reopened = toggleThinkingLevel(next, "low");
		expect(reopened.low).toBe("low");
	});
});
