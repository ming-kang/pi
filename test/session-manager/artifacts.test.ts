import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findMostRecentSession,
	getSessionArtifactDir,
	listSessionOwnedPaths,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { deleteSessionFile } from "../../src/modes/interactive/components/session-selector.ts";

const roots: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-session-artifacts-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A saved session with an artifacts directory holding a nested transcript, plus the late-task sidecar. */
function savedSessionWithArtifacts() {
	const root = tempRoot();
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "Start", timestamp: 1 });
	const file = manager.getSessionFile()!;
	const artifacts = manager.getArtifactDir()!;
	const nested = SessionManager.createAt(join(artifacts, "agents", "agent-1", "transcript.jsonl"), root, {
		parentSession: file,
	});
	nested.appendMessage({ role: "user", content: "Nested", timestamp: 2 });
	writeFileSync(`${file}.tasks-late.jsonl`, "{}\n");
	return { root, manager, file, artifacts, nestedFile: nested.getSessionFile()!, sidecar: `${file}.tasks-late.jsonl` };
}

describe("session artifacts", () => {
	it("names the directory a saved session owns, and none for an unsaved session", () => {
		const root = tempRoot();
		const manager = SessionManager.create(root, join(root, "sessions"));
		expect(manager.getArtifactDir()).toBe(getSessionArtifactDir(manager.getSessionFile()!));
		expect(manager.getArtifactDir()).toBe(manager.getSessionFile()!.replace(/\.jsonl$/u, ""));
		// Nothing is created until a writer needs the directory.
		expect(existsSync(manager.getArtifactDir()!)).toBe(false);
		expect(SessionManager.inMemory(root).getArtifactDir()).toBeUndefined();
	});

	it("creates a session file at an exact path whose header links its parent", () => {
		const { file, nestedFile, artifacts } = savedSessionWithArtifacts();
		expect(nestedFile).toBe(join(artifacts, "agents", "agent-1", "transcript.jsonl"));
		expect(existsSync(nestedFile)).toBe(true);
		const reopened = SessionManager.open(nestedFile);
		expect(reopened.getHeader()?.parentSession).toBe(file);
	});

	it("never lists or continues into a nested transcript", async () => {
		const { root, manager, file } = savedSessionWithArtifacts();
		const sessionDir = join(root, "sessions");
		const listed = await SessionManager.list(root, sessionDir);
		expect(listed.map((info) => info.path)).toEqual([file]);
		expect(findMostRecentSession(sessionDir)).toBe(file);
		expect(SessionManager.continueRecent(root, sessionDir).getSessionFile()).toBe(manager.getSessionFile());
	});
});

describe("session deletion", () => {
	it("lists only what exists", () => {
		const root = tempRoot();
		const file = join(root, "plain.jsonl");
		writeFileSync(file, "");
		expect(listSessionOwnedPaths(file)).toEqual([file]);
		mkdirSync(join(root, "plain"));
		expect(listSessionOwnedPaths(file)).toEqual([file, join(root, "plain")]);
	});

	it("removes the session file, its artifacts directory and its late-task sidecar together", async () => {
		const { file, artifacts, sidecar, nestedFile } = savedSessionWithArtifacts();
		expect(existsSync(nestedFile)).toBe(true);
		const result = await deleteSessionFile(file);
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(existsSync(file)).toBe(false);
		expect(existsSync(artifacts)).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
	});

	it("deletes a session that owns nothing else", async () => {
		const root = tempRoot();
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "Start", timestamp: 1 });
		const file = manager.getSessionFile()!;
		expect((await deleteSessionFile(file)).ok).toBe(true);
		expect(existsSync(file)).toBe(false);
	});
});
