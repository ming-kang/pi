/**
 * ExtensionRunner behavior this distribution adds: the canonical model runtime
 * on the extension context and the background detach key reservation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
// The detach key reserved against extension shortcuts is registered by the background extension.
import "../src/extensions/background/keybindings.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionRunner distribution behavior", () => {
	let tempDir: string;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	const defaultKeybindings = new KeybindingsManager().getEffectiveConfig();

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-dist-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createRunner(): Promise<ExtensionRunner> {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
	}

	it("exposes the registry's canonical runtime on the extension context", async () => {
		const runner = await createRunner();

		expect(runner.createContext().modelRuntime).toBe(modelRegistry.getRuntime());
	});

	it("reserves detach defaults and rebindings, but permits explicitly freed keys", async () => {
		fs.writeFileSync(
			path.join(extensionsDir, "detach.ts"),
			`
			export default function(pi) {
				pi.registerShortcut("ctrl+b", { description: "b", handler: async () => {} });
				pi.registerShortcut("ctrl+x", { description: "x", handler: async () => {} });
			}
		`,
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const runner = await createRunner();
			expect(runner.getShortcuts(defaultKeybindings).has("ctrl+b")).toBe(false);
			const rebound = runner.getShortcuts({ ...defaultKeybindings, "app.backgroundTasks.detach": "ctrl+x" });
			expect(rebound.has("ctrl+x")).toBe(false);
			expect(rebound.has("ctrl+b")).toBe(true);
			expect(runner.getShortcuts({ ...defaultKeybindings, "app.backgroundTasks.detach": [] }).has("ctrl+b")).toBe(
				true,
			);
		} finally {
			warn.mockRestore();
		}
	});
});
