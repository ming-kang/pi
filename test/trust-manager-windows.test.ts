import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore on Windows", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-windows-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.skipIf(process.platform !== "win32")("matches decisions regardless of Windows path casing", () => {
		const store = new ProjectTrustStore(agentDir);
		const alternateCasing = cwd
			.replace(/project$/, "PROJECT")
			.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);

		store.set(cwd, true);
		expect(store.get(alternateCasing)).toBe(true);

		store.set(alternateCasing, false);
		expect(store.get(cwd)).toBe(false);
		const stored = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf-8")) as Record<string, boolean>;
		expect(Object.keys(stored)).toHaveLength(1);
	});
});
