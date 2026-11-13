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
		await first.setExtensionSettings("agent", { model: "test/model", thinking: "high" });
		await second.setExtensionSettings("other", { enabled: false });
		expect(JSON.parse(storage.text)).toEqual({
			theme: "dark",
			extensionSettings: { agent: { model: "test/model", thinking: "high" }, other: { enabled: false } },
		});
		await first.setExtensionSettings("agent", { model: "test/model", thinking: "high" });
		expect(storage.writes).toBe(2);
		await first.setExtensionSettings("agent", {});
		expect(first.getExtensionSettings("agent")).toEqual({});
	});

	it("reports write and parse failures without changing the readable value", async () => {
		const storage = new Storage();
		const manager = SettingsManager.fromStorage(storage);
		storage.fail = true;
		await expect(manager.setExtensionSettings("agent", { model: "test/model" })).rejects.toThrow("Disk unavailable");
		expect(manager.getExtensionSettings("agent")).toEqual({});
		storage.fail = false;
		storage.text = "{broken";
		await expect(manager.setExtensionSettings("agent", {})).rejects.toThrow();
		expect(storage.text).toBe("{broken");
	});

	it("treats prototype keys like constructor as ordinary namespaces", async () => {
		const storage = new Storage();
		const manager = SettingsManager.fromStorage(storage);
		// "constructor" passes the namespace regex but must not resolve through Object.prototype.
		expect(manager.getExtensionSettings("constructor")).toEqual({});
		await manager.setExtensionSettings("constructor", { model: "test/model" });
		expect(manager.getExtensionSettings("constructor")).toEqual({ model: "test/model" });
		expect(JSON.parse(storage.text)).toMatchObject({ extensionSettings: { constructor: { model: "test/model" } } });
		// An unchanged prototype-key write is skipped, and sibling namespaces stay isolated.
		const writes = storage.writes;
		await manager.setExtensionSettings("constructor", { model: "test/model" });
		expect(storage.writes).toBe(writes);
		expect(manager.getExtensionSettings("tostring")).toEqual({});
		expect(manager.getExtensionSettings("other")).toEqual({ enabled: true });
	});

	it("returns detached global data and rejects invalid namespaces and values", async () => {
		const manager = SettingsManager.inMemory({ extensionSettings: { agent: { model: "test/model" } } });
		const value = manager.getExtensionSettings("agent");
		value.model = "changed";
		expect(manager.getExtensionSettings("agent")).toEqual({ model: "test/model" });
		await expect(manager.setExtensionSettings("__proto__", {})).rejects.toThrow();
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		await expect(manager.setExtensionSettings("agent", cyclic)).rejects.toThrow();
	});
});
