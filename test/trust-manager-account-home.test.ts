import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ homedir: "" }));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof os>();
	return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: account.homedir }) };
});

const actualOs = await vi.importActual<typeof os>("node:os");
const { hasTrustRequiringProjectResources } = await import("../src/core/trust-manager.ts");

describe("project trust with HOME away from the account home", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(actualOs.tmpdir(), "trust-account-home-"));
		account.homedir = join(tempDir, "account");
		// HOME names the real profile, which is only read: Windows keeps temp directories inside it, so a
		// ~/.agents/skills there must count as the user's. The temporary account home is the one under test.
		vi.stubEnv("HOME", actualOs.userInfo().homedir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("treats the account's ~/.agents/skills as the user's own, not a project resource", () => {
		mkdirSync(join(account.homedir, ".agents", "skills"), { recursive: true });
		const projectDir = join(account.homedir, "project");
		mkdirSync(projectDir, { recursive: true });

		expect(hasTrustRequiringProjectResources(projectDir)).toBe(false);
	});

	it("still requires trust for a project's own .agents/skills", () => {
		const projectDir = join(account.homedir, "project");
		mkdirSync(join(projectDir, ".agents", "skills"), { recursive: true });

		expect(hasTrustRequiringProjectResources(projectDir)).toBe(true);
	});
});
