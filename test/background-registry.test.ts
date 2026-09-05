/** Legacy registry coverage migrated to the authoritative core output helpers.
 * Execution, notification coordination and admission are covered in background-service.test.ts;
 * process/output ownership and exclusive file allocation in bash-background.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOutputSlice } from "../src/core/background/output.ts";

const dirs: string[] = [];
function file(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-bg-output-"));
	dirs.push(dir);
	const path = join(dir, "output.log");
	writeFileSync(path, text);
	return path;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("core background output (migrated registry reads)", () => {
	it("reads bounded head and tail without reading the whole file", async () => {
		const path = file("abcdefghij");
		expect(await readOutputSlice(path, { mode: "head", bytes: 4 })).toEqual({
			text: "abcd",
			totalBytes: 10,
			truncated: true,
			fromByte: 0,
		});
		expect(await readOutputSlice(path, { mode: "tail", bytes: 4 })).toEqual({
			text: "ghij",
			totalBytes: 10,
			truncated: true,
			fromByte: 6,
		});
	});
	it("aligns both UTF-8 boundaries, including incomplete final characters", async () => {
		const path = file("→→→→");
		for (const mode of ["head", "tail"] as const) {
			const slice = await readOutputSlice(path, { mode, bytes: 7 });
			expect(slice.text).toBe("→→");
			expect(slice.text).not.toContain("�");
			expect(slice.truncated).toBe(true);
		}
	});
	it("returns whole and empty files and rejects missing paths", async () => {
		expect(await readOutputSlice(file(""))).toEqual({ text: "", totalBytes: 0, truncated: false, fromByte: 0 });
		expect(await readOutputSlice(file("hi\n"))).toMatchObject({ text: "hi\n", truncated: false });
		await expect(readOutputSlice(`${file("")}.missing`)).rejects.toThrow();
	});
	it("returns deltas, tail-aligning only when they exceed the budget", async () => {
		const path = file("0123456789");
		expect(await readOutputSlice(path, { sinceBytes: 4, bytes: 100 })).toEqual({
			text: "456789",
			fromByte: 4,
			totalBytes: 10,
			truncated: false,
		});
		expect(await readOutputSlice(path, { sinceBytes: 0, bytes: 4 })).toEqual({
			text: "6789",
			fromByte: 6,
			totalBytes: 10,
			truncated: true,
		});
	});
	it("returns no delta at EOF and a recoverable tail for stale offsets", async () => {
		const path = file("0123456789");
		expect(await readOutputSlice(path, { sinceBytes: 10 })).toMatchObject({
			text: "",
			fromByte: 10,
			truncated: false,
		});
		expect(await readOutputSlice(path, { sinceBytes: 99, bytes: 4 })).toMatchObject({
			text: "6789",
			fromByte: 6,
			truncated: true,
		});
	});
	it("preserves newline boundaries and mid-line slices exactly", async () => {
		const path = file("line one\nline two\n");
		expect((await readOutputSlice(path, { sinceBytes: 4 })).text).toBe(" one\nline two\n");
		expect((await readOutputSlice(path, { sinceBytes: 9 })).text).toBe("line two\n");
	});
});
