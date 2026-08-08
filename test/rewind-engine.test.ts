/**
 * Integration tests for the rewind extension's file-history engine against a
 * real temp directory (engine.ts + storage.ts are Pi-free by design).
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

import {
	applySnapshot,
	applySnapshotDetailed,
	beginTurn,
	capSnapshots,
	collectChangePlan,
	collectChanges,
	disposeSession,
	endTurn,
	getDroppedSnapshotAnchors,
	getSnapshots,
	migrateBackupsFromSession,
	registerSession,
	restoreStateFromSnapshots,
	trackEdit,
} from "../src/extensions/rewind/engine.ts";
import type { FileHistorySnapshot } from "../src/extensions/rewind/snapshot.ts";
import { configureStorage } from "../src/extensions/rewind/storage.ts";

const root = mkdtempSync(join(tmpdir(), "pi-rewind-test-"));
const backupsRoot = join(root, "backups");
const sessionsRoot = join(root, "sessions");
configureStorage({ backupsRoot, sessionsRoot });

let seq = 0;
let sid = "";
let cwd = "";

beforeEach(() => {
	sid = `session-${++seq}`;
	cwd = join(root, `cwd-${seq}`);
	mkdirSync(cwd, { recursive: true });
	registerSession(sid, cwd);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** Simulate one agent run: beginTurn, edits (trackEdit before each write), endTurn. */
async function runTurn(
	anchor: string,
	edits: Array<{ file: string; content: string }>,
): Promise<FileHistorySnapshot | null> {
	await beginTurn(sid);
	for (const e of edits) {
		const abs = join(cwd, e.file);
		trackEdit(sid, abs);
		writeFileSync(abs, e.content, "utf8");
	}
	return endTurn(sid, anchor, anchor, "", new Date().toISOString());
}

describe("rewind engine", () => {
	test("roundtrip: frames record turn-start state and applySnapshot restores it", async () => {
		const f = join(cwd, "f.txt");
		writeFileSync(f, "one", "utf8");

		const frame1 = await runTurn("u1", [{ file: "f.txt", content: "two" }]);
		expect(frame1).not.toBeNull();

		const frame2 = await runTurn("u2", [{ file: "f.txt", content: "three" }]);
		expect(frame2).not.toBeNull();

		// Restoring to turn 2's frame = state when turn 2 began.
		const changed2 = await collectChanges(sid, frame2!);
		expect(changed2).toEqual([f]);
		await applySnapshot(sid, frame2!, { onlyPaths: new Set(changed2) });
		expect(readFileSync(f, "utf8")).toBe("two");

		// Restoring to turn 1's frame = the original content.
		await applySnapshot(sid, frame1!);
		expect(readFileSync(f, "utf8")).toBe("one");
		expect(await collectChanges(sid, frame1!)).toEqual([]);
	});

	test("a failed pre-edit backup discards the incomplete frame", async () => {
		await beginTurn(sid);
		expect(() => trackEdit(sid, cwd)).toThrow();
		expect(endTurn(sid, "u1", "u1", "", new Date().toISOString())).toBeNull();
		expect(getSnapshots(sid)).toHaveLength(0);
	});

	test("empty anchor discards the frame instead of keeping it memory-only", async () => {
		writeFileSync(join(cwd, "g.txt"), "before", "utf8");
		const frame = await runTurn("", [{ file: "g.txt", content: "after" }]);
		expect(frame).toBeNull();
		expect(getSnapshots(sid)).toHaveLength(0);
	});

	test("a turn with no changes produces no frame", async () => {
		writeFileSync(join(cwd, "h.txt"), "same", "utf8");
		await runTurn("u1", [{ file: "h.txt", content: "changed" }]);
		// Turn 2's beginTurn re-records the post-edit state (a real frame)...
		expect(await runTurn("u2", [])).not.toBeNull();
		// ...after which an idle turn records nothing new.
		expect(await runTurn("u3", [])).toBeNull();
		expect(getSnapshots(sid)).toHaveLength(2);
	});

	test("file created by a turn is deleted when rewinding before it", async () => {
		const created = join(cwd, "new.txt");
		const frame = await runTurn("u1", [{ file: "new.txt", content: "fresh" }]);
		expect(frame).not.toBeNull();
		expect(existsSync(created)).toBe(true);

		const changed = await collectChanges(sid, frame!);
		expect(changed).toEqual([created]);
		await applySnapshot(sid, frame!, { onlyPaths: new Set(changed) });
		expect(existsSync(created)).toBe(false);
	});

	test("capSnapshots keeps the trailing window and reload honors the cap", async () => {
		const frames: FileHistorySnapshot[] = [];
		for (let i = 1; i <= 3; i++) {
			const frame = await runTurn(`u${i}`, [{ file: "r.txt", content: `v${i}` }]);
			expect(frame).not.toBeNull();
			frames.push(frame!);
		}
		expect(capSnapshots(frames, 2).map((s) => s.userEntryId)).toEqual(["u2", "u3"]);

		disposeSession(sid);
		restoreStateFromSnapshots(sid, cwd, frames, 2);
		expect(getSnapshots(sid).map((s) => s.userEntryId)).toEqual(["u2", "u3"]);

		disposeSession(sid);
		restoreStateFromSnapshots(sid, cwd, frames, 1);
		expect(getDroppedSnapshotAnchors(sid)).toEqual(["u1", "u2"]);
	});

	test("frames dropped from the ring release blobs no retained frame references", async () => {
		// maxSnapshots=1: finalizing turn 2 drops turn 1's frame; its unique v1
		// blob must be unlinked while turn 2's blob survives.
		const f = join(cwd, "p.txt");
		writeFileSync(f, "one", "utf8");

		await beginTurn(sid);
		trackEdit(sid, f);
		writeFileSync(f, "two", "utf8");
		expect(endTurn(sid, "u1", "u1", "", new Date().toISOString(), 1)).not.toBeNull();

		await beginTurn(sid);
		trackEdit(sid, f);
		writeFileSync(f, "three", "utf8");
		expect(endTurn(sid, "u2", "u2", "", new Date().toISOString(), 1)).not.toBeNull();

		expect(getSnapshots(sid)).toHaveLength(1);
		const live = new Set(
			Object.values(getSnapshots(sid)[0]!.trackedFileBackups)
				.map((b) => b.backupName)
				.filter((n): n is string => n !== null),
		);
		expect(live.size).toBeGreaterThan(0);
		// Prune is fire-and-forget; wait until only live blobs remain.
		const dir = join(backupsRoot, sid);
		await waitFor(() => readdirSync(dir).every((name) => live.has(name)));
	});

	test("missing blobs are excluded from restore plans and never reported as restored", async () => {
		const f = join(cwd, "missing.txt");
		writeFileSync(f, "before", "utf8");
		const frame = await runTurn("u1", [{ file: "missing.txt", content: "after" }]);
		expect(frame).not.toBeNull();
		const blob = frame!.trackedFileBackups["missing.txt"]?.backupName;
		expect(blob).toBeTypeOf("string");
		rmSync(join(backupsRoot, sid, blob!), { force: true });

		const plan = await collectChangePlan(sid, frame!);
		expect(plan).toEqual({ changedPaths: [], unavailablePaths: [f] });
		const result = await applySnapshotDetailed(sid, frame!, { onlyPaths: new Set([f]) });
		expect(result).toEqual({ changedPaths: [], unavailablePaths: [f] });
		expect(readFileSync(f, "utf8")).toBe("after");
		unlinkSync(f);
		expect(await applySnapshotDetailed(sid, frame!)).toEqual({ changedPaths: [], unavailablePaths: [f] });
	});

	test("corrupt blobs are unavailable and never overwrite the worktree", async () => {
		const f = join(cwd, "corrupt.txt");
		writeFileSync(f, "before", "utf8");
		const frame = await runTurn("u1", [{ file: "corrupt.txt", content: "after" }]);
		expect(frame).not.toBeNull();
		const blob = frame!.trackedFileBackups["corrupt.txt"]?.backupName;
		expect(blob).toBeTypeOf("string");
		writeFileSync(join(backupsRoot, sid, blob!), "CORRUPTED", "utf8");

		expect(await collectChangePlan(sid, frame!)).toEqual({ changedPaths: [], unavailablePaths: [f] });
		expect(await applySnapshotDetailed(sid, frame!)).toEqual({ changedPaths: [], unavailablePaths: [f] });
		expect(readFileSync(f, "utf8")).toBe("after");
	});

	test("fork migration rejects a parent blob whose checksum does not match", async () => {
		const f = join(cwd, "corrupt-parent.txt");
		writeFileSync(f, "before", "utf8");
		const frame = await runTurn("u1", [{ file: "corrupt-parent.txt", content: "after" }]);
		expect(frame).not.toBeNull();
		const blob = frame!.trackedFileBackups["corrupt-parent.txt"]?.backupName;
		expect(blob).toBeTypeOf("string");
		writeFileSync(join(backupsRoot, sid, blob!), "bad", "utf8");
		const forkSid = `${sid}-checksum-fork`;
		await migrateBackupsFromSession(sid, forkSid, [frame!]);
		expect(existsSync(join(backupsRoot, forkSid, blob!))).toBe(false);
	});

	test("fork migration replaces a stale same-name destination blob", async () => {
		const f = join(cwd, "shared.txt");
		writeFileSync(f, "parent", "utf8");
		const frame = await runTurn("u1", [{ file: "shared.txt", content: "edited" }]);
		expect(frame).not.toBeNull();
		const blob = frame!.trackedFileBackups["shared.txt"]?.backupName;
		expect(blob).toBeTypeOf("string");

		const forkSid = `${sid}-fork`;
		const forkDir = join(backupsRoot, forkSid);
		mkdirSync(forkDir, { recursive: true });
		writeFileSync(join(forkDir, blob!), "wrong!", "utf8");
		await migrateBackupsFromSession(sid, forkSid, [frame!]);
		expect(readFileSync(join(forkDir, blob!), "utf8")).toBe("parent");

		const missingSid = `${sid}-missing-parent`;
		const missingForkDir = join(backupsRoot, missingSid);
		mkdirSync(missingForkDir, { recursive: true });
		const deadBlob = "0000000000000000@v1";
		writeFileSync(join(missingForkDir, deadBlob), "stale", "utf8");
		await migrateBackupsFromSession(sid, missingSid, [
			{ ...frame!, trackedFileBackups: { "shared.txt": { backupName: deadBlob, version: 1 } } },
		]);
		expect(existsSync(join(missingForkDir, deadBlob))).toBe(false);
	});

	test("oversized tracked files use a metadata fingerprint after their first backup", async () => {
		const f = join(cwd, "large.bin");
		writeFileSync(f, "a", "utf8");
		const large = "x".repeat(25 * 1024 * 1024 + 1);
		expect(await runTurn("u1", [{ file: "large.bin", content: large }])).not.toBeNull();
		expect(await runTurn("u2", [])).not.toBeNull();
		expect(await runTurn("u3", [])).toBeNull();
	});

	test("beginTurn re-backs up a same-size external replacement with an older mtime", async () => {
		const f = join(cwd, "begin-mtime.txt");
		writeFileSync(f, "AAAA", "utf8");
		const first = await runTurn("u1", [{ file: "begin-mtime.txt", content: "BBBB" }]);
		expect(first).not.toBeNull();

		writeFileSync(f, "CCCC", "utf8");
		const past = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(f, past, past);
		const second = await runTurn("u2", []);
		expect(second).not.toBeNull();
		const blob = second!.trackedFileBackups["begin-mtime.txt"]?.backupName;
		expect(blob).toMatch(/@v2$/);
		expect(readFileSync(join(backupsRoot, sid, blob!), "utf8")).toBe("CCCC");
	});

	test("restore-side change detection is not fooled by an mtime-preserving content swap", async () => {
		// Same size + mode, older mtime than the backup, different content —
		// simulates archive extraction / touch -d. The strict (non-trustMtime)
		// path used by collectChanges must still flag it.
		const f = join(cwd, "m.txt");
		writeFileSync(f, "AAAA", "utf8");
		const frame = await runTurn("u1", [{ file: "m.txt", content: "BBBB" }]);
		expect(frame).not.toBeNull();

		// Swap content, then force an mtime far in the past.
		writeFileSync(f, "CCCC", "utf8");
		const past = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(f, past, past);

		const changed = await collectChanges(sid, frame!);
		expect(changed).toEqual([f]);
		await applySnapshot(sid, frame!, { onlyPaths: new Set(changed) });
		expect(readFileSync(f, "utf8")).toBe("AAAA");
	});
});
