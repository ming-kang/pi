import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const model = { provider: "provider", id: "family/model" };
const modelKey = "provider/family/model";
const defaults = { enabled: true, keepRecentTokens: 20000, triggerPercent: 85 };

// Regression coverage for #8133. This distribution keeps `keepRecentTokens` as the only
// compaction token setting; the summary reserve follows the percentage trigger policy.
describe("compaction model overrides", () => {
	it("uses defaults without compaction settings", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getCompactionSettings()).toEqual(defaults);
		expect(manager.getCompactionSettings(model)).toEqual(defaults);
	});

	it("prefers the model override over the ordinary setting and keeps getters consistent", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				keepRecentTokens: 10000,
				modelOverrides: { [modelKey]: { keepRecentTokens: 400000 } },
			},
		});
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 400000 });
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(400000);
		expect(manager.getCompactionSettings()).toEqual({ ...defaults, keepRecentTokens: 10000 });

		manager.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 30000 } } } });
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
	});

	it("falls back to built-in defaults for missing fields", () => {
		const manager = SettingsManager.inMemory({
			compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 1024 } } },
		});
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 1024 });
	});

	it("matches exact provider/model IDs, including IDs containing slashes", () => {
		const manager = SettingsManager.inMemory({
			compaction: {
				modelOverrides: {
					[modelKey]: { keepRecentTokens: 400000 },
					"provider/*": { keepRecentTokens: 1 },
					"family/model": { keepRecentTokens: 2 },
				},
			},
		});
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(400000);
		for (const other of [
			{ provider: "other", id: model.id },
			{ provider: model.provider, id: "other" },
			{ provider: model.provider, id: "family/Model" },
		]) {
			expect(manager.getCompactionSettings(other)).toEqual(defaults);
		}
	});

	it("merges project model overrides per field before resolving fallbacks", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					keepRecentTokens: 8192,
					modelOverrides: {
						[modelKey]: { keepRecentTokens: 30000 },
						"provider/other": { keepRecentTokens: 4096 },
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: 2000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 2000 });
		expect(manager.getCompactionSettings({ provider: "provider", id: "other" })).toEqual({
			...defaults,
			keepRecentTokens: 4096,
		});
		await manager.reload();
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(2000);
		manager.setProjectTrusted(false);
		expect(manager.getCompactionKeepRecentTokens(model)).toBe(30000);
	});

	it("keeps enabled global and preserves overrides when saving the toggle", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: { modelOverrides: { [modelKey]: { enabled: false, keepRecentTokens: 400000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings(model).enabled).toBe(true);
		manager.setCompactionEnabled(false);
		await manager.flush();
		await manager.reload();
		expect(manager.getCompactionSettings(model)).toEqual({
			...defaults,
			enabled: false,
			keepRecentTokens: 400000,
		});
	});

	describe("model override keepRecentTokens", () => {
		it.each([null, -1, 1.5, "400000", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
			"reports invalid token values: %j",
			(value) => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({
						compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: value } } },
					}),
				);
				const manager = SettingsManager.fromStorage(storage);
				expect(() => manager.getCompactionSettings(model)).toThrow(
					`Invalid compaction.modelOverrides["${modelKey}"].keepRecentTokens setting: ${String(value)}. Expected a non-negative safe integer.`,
				);
				expect(manager.getCompactionSettings()).toEqual(defaults);
				expect(manager.getCompactionSettings({ provider: "other", id: model.id })).toEqual(defaults);
			},
		);

		it.each([Number.NaN, Infinity, -Infinity])("reports non-finite runtime values: %s", (value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { modelOverrides: { [modelKey]: { keepRecentTokens: value } } } });
			expect(() => manager.getCompactionSettings(model)).toThrow(
				`Invalid compaction.modelOverrides["${modelKey}"].keepRecentTokens setting: ${String(value)}`,
			);
		});
	});

	describe("ordinary compaction.keepRecentTokens", () => {
		it.each([null, -1, 1.5, "400000", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
			"reports invalid values even when a valid model override exists: %j",
			(value) => {
				const storage = new InMemorySettingsStorage();
				storage.withLock("global", () =>
					JSON.stringify({
						compaction: {
							keepRecentTokens: value,
							modelOverrides: { [modelKey]: { keepRecentTokens: 4096 } },
						},
					}),
				);
				const manager = SettingsManager.fromStorage(storage);
				const error = `Invalid compaction.keepRecentTokens setting: ${String(value)}. Expected a non-negative safe integer.`;
				expect(() => manager.getCompactionSettings()).toThrow(error);
				expect(() => manager.getCompactionSettings(model)).toThrow(error);
			},
		);

		it.each([Number.NaN, Infinity, -Infinity])("reports non-finite runtime values: %s", (value) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { keepRecentTokens: value } });
			expect(() => manager.getCompactionSettings()).toThrow(
				`Invalid compaction.keepRecentTokens setting: ${String(value)}`,
			);
		});
	});

	it.each([null, false, 42, "invalid", []])("reports malformed model entries: %j", (entry) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ compaction: { modelOverrides: { [modelKey]: entry } } }));
		expect(() => SettingsManager.fromStorage(storage).getCompactionSettings(model)).toThrow(
			`Invalid compaction.modelOverrides["${modelKey}"] setting: ${String(entry)}. Expected an object.`,
		);
	});

	it("accepts zero in ordinary settings and model overrides", () => {
		const manager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 0 } });
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 0 });
		manager.applyOverrides({
			compaction: { keepRecentTokens: 1000, modelOverrides: { [modelKey]: { keepRecentTokens: 0 } } },
		});
		expect(manager.getCompactionSettings(model)).toEqual({ ...defaults, keepRecentTokens: 0 });
	});
});
