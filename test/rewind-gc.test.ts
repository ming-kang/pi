import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import { activeSessionIds, runGc, sessionIdFromFile, sessionInfoFromFile } from "../src/extensions/rewind/gc.ts";
import { configureStorage } from "../src/extensions/rewind/storage.ts";

const root = mkdtempSync(join(tmpdir(), "pi-rewind-gc-test-"));
const backupsRoot = join(root, "backups");
const sessionsRoot = join(root, "sessions");
const customSessionsRoot = join(root, "custom-sessions");

beforeEach(() => {
	configureStorage({ backupsRoot, sessionsRoot, sessionsRoots: [customSessionsRoot] });
	rmSync(backupsRoot, { recursive: true, force: true });
	rmSync(sessionsRoot, { recursive: true, force: true });
	rmSync(customSessionsRoot, { recursive: true, force: true });
	mkdirSync(backupsRoot, { recursive: true });
	mkdirSync(sessionsRoot, { recursive: true });
	mkdirSync(customSessionsRoot, { recursive: true });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeSession(file: string, id: string, parentSession?: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp", parentSession })}\n`,
		"utf8",
	);
}

describe("rewind session discovery", () => {
	test("uses the header id when a session id contains underscores", () => {
		const file = join(customSessionsRoot, "2026-01-01_wrong-suffix.jsonl");
		writeSession(file, "my_session_123", "parent_session.jsonl");
		const header = readFileSync(file, "utf8");
		writeFileSync(file, `not-json\n\n${header}`, "utf8");
		expect(sessionIdFromFile(file)).toBe("my_session_123");
		expect(sessionInfoFromFile(file)?.parentSession).toBe("parent_session.jsonl");
	});

	test("scans both flat custom roots and the default nested layout", () => {
		const nested = join(sessionsRoot, "encoded-cwd", "nested.jsonl");
		const flat = join(customSessionsRoot, "flat.jsonl");
		writeSession(nested, "nested_session");
		writeSession(flat, "flat_session");
		expect(activeSessionIds()).toEqual(new Set(["nested_session", "flat_session"]));
	});

	test("does not classify a live custom-root session as an orphan", () => {
		const id = "custom_live_session";
		const sessionFile = join(customSessionsRoot, "live.jsonl");
		writeSession(sessionFile, id);
		const backupDir = join(backupsRoot, id);
		mkdirSync(backupDir, { recursive: true });
		writeFileSync(join(backupDir, "0000000000000000@v1"), "backup", "utf8");
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		utimesSync(backupDir, old, old);

		expect(runGc(0, "other")).toEqual({ removed: 0, reclaimedBytes: 0 });
		expect(existsSync(backupDir)).toBe(true);
	});
});
