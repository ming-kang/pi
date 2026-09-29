import { describe, expect, it } from "vitest";
import { SettingsManager, type SettingsScope, type SettingsStorage } from "../src/core/settings-manager.ts";

class Storage implements SettingsStorage {
	text = JSON.stringify({ theme: "dark", extensionSettings: { other: { enabled: true } } });
	writes = 0;
	fail = false;
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const next = fn(scope === "global" ? this.text : undefined);
		if (scope === "global" && next !== undefined) {
			if (this.fail) throw new Error("Disk unavailable");
			this.text = next;
			this.writes++;
		}
	}
}

describe("extension settings", () => {
	it("merges only the requested namespace with concurrent writes and skips unchanged values", async () => {
		const storage = new Storage();
		const first = SettingsManager.fromStorage(storage);
		const second = SettingsManager.fromStorage(storage);
		await first.setExtensionSettings("explore", { model: "test/model" });
		await second.setExtensionSettings("other", { enabled: false });
		expect(JSON.parse(storage.text)).toEqual({
			theme: "dark",
			extensionSettings: { explore: { model: "test/model" }, other: { enabled: false } },
		});
		await first.setExtensionSettings("explore", { model: "test/model" });
		expect(storage.writes).toBe(2);
		await first.setExtensionSettings("explore", {});
		expect(first.getExtensionSettings("explore")).toEqual({});
	});
	it("reports write and parse failures without changing the readable value", async () => {
		const storage = new Storage();
		const manager = SettingsManager.fromStorage(storage);
		storage.fail = true;
		await expect(manager.setExtensionSettings("explore", { model: "test/model" })).rejects.toThrow(
			"Disk unavailable",
		);
		expect(manager.getExtensionSettings("explore")).toEqual({});
		storage.fail = false;
		storage.text = "{broken";
		await expect(manager.setExtensionSettings("explore", {})).rejects.toThrow();
		expect(storage.text).toBe("{broken");
	});
	it("returns detached global data and rejects invalid namespaces", async () => {
		const manager = SettingsManager.inMemory({ extensionSettings: { explore: { model: "test/model" } } });
		const value = manager.getExtensionSettings("explore");
		value.model = "changed";
		expect(manager.getExtensionSettings("explore")).toEqual({ model: "test/model" });
		await expect(manager.setExtensionSettings("__proto__", {})).rejects.toThrow();
	});
});
