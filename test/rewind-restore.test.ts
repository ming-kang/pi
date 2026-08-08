/**
 * Tests for the rewind extension's /tree snapshot selection (restore.ts) and
 * turn-anchor resolution (anchor.ts). Both modules are pure, so trees are
 * modeled structurally.
 *
 * Snapshot semantics under test: a frame anchored at user entry U records the
 * work tree at the moment U's run STARTED. navigateTree removes a user target's
 * turn (leaf = parent) but keeps a non-user target's turn (leaf = target), so:
 *   - user target  -> the snapshot anchored at the target (state before the turn)
 *   - other target -> the first snapshot anchored at a descendant turn (state
 *     after the turn), or nothing at all — never an ancestor frame, which would
 *     roll back the target turn's own edits.
 */
import { describe, expect, test } from "vitest";

import { type BranchEntryLike, firstUserEntryIdAfter } from "../src/extensions/rewind/anchor.ts";
import { type EntryTreeView, snapshotForEntry } from "../src/extensions/rewind/restore.ts";
import type { FileHistorySnapshot } from "../src/extensions/rewind/snapshot.ts";

// ---- fixtures -------------------------------------------------------------

interface Node {
	id: string;
	parentId: string | null;
	anchor?: boolean;
}

function makeView(nodes: Node[]): EntryTreeView {
	const byId = new Map(nodes.map((n) => [n.id, { id: n.id, parentId: n.parentId, isTurnAnchor: n.anchor ?? false }]));
	return { getEntry: (id) => byId.get(id) };
}

function snap(anchor: string, label = ""): FileHistorySnapshot {
	return { v: 1, userEntryId: anchor, turnId: anchor, prompt: label, trackedFileBackups: {}, timestamp: "" };
}

// Linear session, three turns. Snapshot entries (custom type) sit between
// turns, mirroring how appendEntry advances the leaf at agent_settled:
//   u1 -> a1 -> snap1e -> u2 -> a2 -> snap2e -> u3 -> a3
const LINEAR: Node[] = [
	{ id: "u1", parentId: null, anchor: true },
	{ id: "a1", parentId: "u1" },
	{ id: "snap1e", parentId: "a1" },
	{ id: "u2", parentId: "snap1e", anchor: true },
	{ id: "a2", parentId: "u2" },
	{ id: "snap2e", parentId: "a2" },
	{ id: "u3", parentId: "snap2e", anchor: true },
	{ id: "a3", parentId: "u3" },
];

// ---- snapshotForEntry -----------------------------------------------------

describe("snapshotForEntry", () => {
	const view = makeView(LINEAR);
	const snapshots = [snap("u1"), snap("u2"), snap("u3")];

	test("user target: exact anchor match (state before that turn)", () => {
		expect(snapshotForEntry(snapshots, view, "u2")?.userEntryId).toBe("u2");
	});

	test("non-user target: first descendant-anchored snapshot (state after that turn)", () => {
		// Navigating to a2 keeps turn 2 in the conversation; the matching state
		// is the one recorded when turn 3 began — NOT turn 2's own frame.
		expect(snapshotForEntry(snapshots, view, "a2")?.userEntryId).toBe("u3");
	});

	test("non-user target in the last turn: no snapshot recorded after it -> undefined", () => {
		// Old bug: this offered to roll back the current turn's own edits.
		expect(snapshotForEntry(snapshots, view, "a3")).toBeUndefined();
	});

	test("snapshot entry as target behaves like its position (descendant rule)", () => {
		expect(snapshotForEntry(snapshots, view, "snap1e")?.userEntryId).toBe("u2");
	});

	test("user target without its own frame falls back to state after its parent", () => {
		// Turn 2 recorded no changes: state before turn 2 == state after a1 ==
		// what turn 3's frame recorded (nothing changed in between).
		const sparse = [snap("u1"), snap("u3")];
		expect(snapshotForEntry(sparse, view, "u2")?.userEntryId).toBe("u3");
	});

	test("user target whose exact frame was evicted does not use a later retained frame", () => {
		expect(snapshotForEntry([snap("u3")], view, "u2", ["u1", "u2"])).toBeUndefined();
	});

	test("non-user target does not skip an evicted next-turn frame", () => {
		// a1's accurate post-turn state is u2. Once u2 is evicted, u3 is too late.
		expect(snapshotForEntry([snap("u3")], view, "a1", ["u1", "u2"])).toBeUndefined();
	});

	test("an evicted frame on another branch does not block a retained descendant", () => {
		const branched = makeView([
			{ id: "u1", parentId: null, anchor: true },
			{ id: "a1", parentId: "u1" },
			{ id: "old", parentId: "a1", anchor: true },
			{ id: "old-a", parentId: "old" },
			{ id: "new", parentId: "a1", anchor: true },
			{ id: "new-a", parentId: "new" },
			{ id: "next", parentId: "new-a", anchor: true },
		]);
		expect(snapshotForEntry([snap("next")], branched, "new-a", ["old"])?.userEntryId).toBe("next");
	});

	test("root user target with no frame -> undefined", () => {
		expect(snapshotForEntry([snap("u3")], view, "u1")).toBeUndefined();
	});

	test("unknown target id -> undefined", () => {
		expect(snapshotForEntry(snapshots, view, "nope")).toBeUndefined();
	});

	test("duplicate anchors: chronologically last frame wins", () => {
		const dup = [snap("u1"), snap("u2", "old"), snap("u2", "new")];
		expect(snapshotForEntry(dup, view, "u2")?.prompt).toBe("new");
	});

	test("branched tree: descendant rule picks the historically next turn, cross-branch anchors ignored", () => {
		// u1 -> a1 -> u2 -> a2   (old branch)
		//         \-> u2b -> a2b (new branch, created after navigating back)
		const branched = makeView([
			{ id: "u1", parentId: null, anchor: true },
			{ id: "a1", parentId: "u1" },
			{ id: "u2", parentId: "a1", anchor: true },
			{ id: "a2", parentId: "u2" },
			{ id: "u2b", parentId: "a1", anchor: true },
			{ id: "a2b", parentId: "u2b" },
		]);
		const snaps = [snap("u1"), snap("u2"), snap("u2b")];
		// After a1, the run that started first was u2's.
		expect(snapshotForEntry(snaps, branched, "a1")?.userEntryId).toBe("u2");
		// Exact matches stay branch-local.
		expect(snapshotForEntry(snaps, branched, "u2b")?.userEntryId).toBe("u2b");
		// a2b ends the new branch; u2 is NOT a descendant of it.
		expect(snapshotForEntry(snaps, branched, "a2b")).toBeUndefined();
	});

	test("frames with empty anchors are skipped by the descendant rule", () => {
		expect(snapshotForEntry([snap("")], view, "a1")).toBeUndefined();
	});
});

// ---- firstUserEntryIdAfter ------------------------------------------------

function userMsg(id: string): BranchEntryLike {
	return { id, type: "message", message: { role: "user" } };
}

function assistantMsg(id: string): BranchEntryLike {
	return { id, type: "message", message: { role: "assistant" } };
}

function customEntry(id: string): BranchEntryLike {
	return { id, type: "custom" };
}

describe("firstUserEntryIdAfter", () => {
	// One run that consumed a steering message: u2 arrived mid-run. The frame
	// recorded the state before u1 ran, so u1 — not u2 — must be the anchor.
	const branch = [customEntry("s0"), userMsg("u1"), assistantMsg("a1"), userMsg("u2"), assistantMsg("a2")];

	test("scans from the recorded pre-run leaf, not the branch tail", () => {
		expect(firstUserEntryIdAfter(branch, "s0")).toBe("u1");
	});

	test("null scan start (fresh session) scans from the root", () => {
		expect(firstUserEntryIdAfter(branch, null)).toBe("u1");
	});

	test("mid-branch scan start picks the next user entry", () => {
		expect(firstUserEntryIdAfter(branch, "a1")).toBe("u2");
	});

	test("no user entry after the scan start -> undefined (frame is discarded)", () => {
		expect(firstUserEntryIdAfter(branch, "a2")).toBeUndefined();
	});

	test("scan start off-branch (leaf moved) -> undefined rather than a wrong anchor", () => {
		expect(firstUserEntryIdAfter(branch, "gone")).toBeUndefined();
	});
});
