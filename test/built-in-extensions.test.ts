import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "./utilities.ts";

function builtIn(name: string) {
	const extension = builtInExtensions.find((candidate) => candidate.name === name);
	if (!extension) throw new Error(`missing built-in extension: ${name}`);
	return extension;
}

function toFactory(extension: (typeof builtInExtensions)[number]) {
	return typeof extension === "function" ? extension : extension.factory;
}

describe("built-in extensions", () => {
	test("load together without errors as configurable built-ins", async () => {
		const loaded = await createTestExtensionsResult(
			builtInExtensions.map((extension) => (typeof extension === "function" ? extension : extension.factory)),
		);
		expect(loaded.errors).toEqual([]);
		expect(
			builtInExtensions.every((extension) => typeof extension !== "function" && extension.builtin === true),
		).toBe(true);
	});

	test("resolve tool-presentation outside mcp so mcp keeps its fallback renderers", async () => {
		// The distribution chrome decorates the final definition, so it has to run after `mcp` in the
		// resolver chain (`next()` order) by being listed before it.
		expect(builtInExtensions.indexOf(builtIn("tool-presentation"))).toBeLessThan(
			builtInExtensions.indexOf(builtIn("mcp")),
		);

		const loaded = await createTestExtensionsResult(builtInExtensions.map(toFactory));
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		// A tool of a server that has not connected (a resumed session) has no registered definition,
		// so `mcp` falls back to its own renderers.
		const renderers = runner.resolveToolRenderers("mcp__docs__search", () => undefined);
		expect(renderers?.renderCall).toBeDefined();
		expect(renderers?.renderResult).toBeDefined();
		expect(renderers?.shell).toBeDefined();
	});
});
