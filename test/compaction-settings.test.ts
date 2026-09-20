import { describe, expect, it } from "vitest";
import { shouldCompact } from "../src/core/compaction/compaction.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const model = { provider: "faux", id: "faux-1", contextWindow: 200_000 };

describe("compaction trigger percentage", () => {
	it("keeps the built-in reserve when the model window is unknown", () => {
		expect(SettingsManager.inMemory().getCompactionSettings()).toEqual({
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		});
	});

	it("derives the reserve from the trigger percentage of the model window", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 30000,
			keepRecentTokens: 20000,
		});
		expect(shouldCompact(170_001, model.contextWindow, manager.getCompactionSettings(model))).toBe(true);
		expect(shouldCompact(170_000, model.contextWindow, manager.getCompactionSettings(model))).toBe(false);
	});

	it("caps the retained tail at half the trigger line on a small window", () => {
		const manager = SettingsManager.inMemory({ compaction: { triggerPercent: 60 } });
		expect(manager.getCompactionSettings({ ...model, contextWindow: 1000 })).toEqual({
			enabled: true,
			reserveTokens: 400,
			keepRecentTokens: 300,
		});
	});

	it("prefers a configured reserve over the percentage, including per model", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				triggerPercent: 60,
				reserveTokens: 8192,
				modelOverrides: { "faux/faux-1": { reserveTokens: 4096 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 4096,
			keepRecentTokens: 20000,
		});
		expect(manager.getCompactionSettings({ ...model, id: "other" })).toEqual({
			enabled: true,
			reserveTokens: 8192,
			keepRecentTokens: 20000,
		});
	});

	it("merges project percentages with global retention, preserves them on save, and reloads changes", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { enabled: true, triggerPercent: 85, keepRecentTokens: 12000 } }),
		);
		storage.withLock("project", () => JSON.stringify({ compaction: { triggerPercent: 60 } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 80_000,
			keepRecentTokens: 12000,
		});

		manager.setTheme("light");
		await manager.flush();
		expect(SettingsManager.fromStorage(storage).getCompactionSettings(model)).toEqual(
			manager.getCompactionSettings(model),
		);

		storage.withLock("project", () => JSON.stringify({ compaction: { triggerPercent: 50 } }));
		await manager.reload();
		expect(manager.getCompactionSettings(model)).toEqual({
			enabled: true,
			reserveTokens: 100_000,
			keepRecentTokens: 12000,
		});
	});

	it.each([
		[5, 20],
		[150, 95],
		[85.5, 85.5],
		[Number.NaN, 85],
		[Number.POSITIVE_INFINITY, 85],
		[Number.NEGATIVE_INFINITY, 85],
	])("uses the same effective percentage for setting %s and the resolved reserve", (configured, expected) => {
		const manager = SettingsManager.inMemory();
		manager.applyOverrides({ compaction: { triggerPercent: configured } });
		expect(manager.getCompactionTriggerPercent()).toBe(expected);

		const settings = manager.getCompactionSettings({ ...model, contextWindow: 100_000 });
		expect(shouldCompact(expected * 1000, 100_000, settings)).toBe(false);
		expect(shouldCompact(expected * 1000 + 1, 100_000, settings)).toBe(true);
	});
});
