import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("compaction settings", () => {
	it("uses the execution defaults when no compaction settings are configured", () => {
		expect(SettingsManager.inMemory().getCompactionSettings()).toEqual(DEFAULT_COMPACTION_SETTINGS);
	});

	it("merges project percentages with global retention, preserves them on save, and reloads changes", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { enabled: true, triggerPercent: 85, keepRecentTokens: 12000 } }),
		);
		storage.withLock("project", () => JSON.stringify({ compaction: { triggerPercent: 60 } }));
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings()).toEqual({ enabled: true, triggerPercent: 60, keepRecentTokens: 12000 });

		manager.setTheme("light");
		await manager.flush();
		expect(SettingsManager.fromStorage(storage).getCompactionSettings()).toEqual(manager.getCompactionSettings());

		storage.withLock("project", () => JSON.stringify({ compaction: { triggerPercent: 50 } }));
		await manager.reload();
		expect(manager.getCompactionSettings()).toEqual({ enabled: true, triggerPercent: 50, keepRecentTokens: 12000 });
	});

	it("ignores the removed compaction reserve without changing branch summary settings", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({ compaction: { reserveTokens: 8192 }, branchSummary: { reserveTokens: 4096 } }),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings()).toEqual(DEFAULT_COMPACTION_SETTINGS);
		expect(manager.getBranchSummarySettings().reserveTokens).toBe(4096);
	});

	it.each([
		[5, 20],
		[150, 95],
		[85.5, 85.5],
		[Number.NaN, 85],
		[Number.POSITIVE_INFINITY, 85],
		[Number.NEGATIVE_INFINITY, 85],
	])("uses the same effective percentage for setting %s and direct SDK settings", (configured, expected) => {
		const manager = SettingsManager.inMemory();
		manager.applyOverrides({ compaction: { triggerPercent: configured } });
		expect(manager.getCompactionTriggerPercent()).toBe(expected);
		expect(manager.getCompactionSettings().triggerPercent).toBe(expected);

		const settings = { ...DEFAULT_COMPACTION_SETTINGS, triggerPercent: configured };
		expect(shouldCompact(expected * 1000, 100000, settings)).toBe(false);
		expect(shouldCompact(expected * 1000 + 1, 100000, settings)).toBe(true);
	});
});
