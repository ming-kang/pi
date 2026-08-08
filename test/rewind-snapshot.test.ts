import { describe, expect, test } from "vitest";

import { isSafeBackupName, isSnapshot } from "../src/extensions/rewind/snapshot.ts";

const valid = {
	v: 1,
	userEntryId: "user-1",
	turnId: "leaf-1",
	prompt: "prompt",
	timestamp: "",
	trackedFileBackups: {
		"src/file.ts": { backupName: "0123456789abcdef@v1", version: 1 },
	},
};

describe("rewind snapshot validation", () => {
	test("accepts the persisted snapshot shape", () => {
		expect(isSnapshot(valid)).toBe(true);
		expect(isSafeBackupName("0123456789abcdef@v42")).toBe(true);
	});

	test.each([
		["missing version", { ...valid, v: undefined }],
		["missing turn fields", { ...valid, turnId: 1 }],
		["array backup map", { ...valid, trackedFileBackups: [] }],
		["invalid blob path", { ...valid, trackedFileBackups: { file: { backupName: "../../secret", version: 1 } } }],
		[
			"invalid version",
			{ ...valid, trackedFileBackups: { file: { backupName: "0123456789abcdef@v0", version: 0 } } },
		],
		["nul tracking path", { ...valid, trackedFileBackups: { "bad\0path": { backupName: null, version: 1 } } }],
		["relative traversal path", { ...valid, trackedFileBackups: { "../victim": { backupName: null, version: 1 } } }],
	] as const)("rejects %s", (_label, value) => {
		expect(isSnapshot(value)).toBe(false);
	});
});
