import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool, type EditOperations } from "../src/core/tools/edit.ts";
import { THEN_RUN_SKIPPED } from "../src/core/tools/then-run.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-then-run-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function textBlocks(result: { content: Array<{ type: string; text?: string }> }): string[] {
	return result.content.filter((block) => block.type === "text").map((block) => block.text ?? "");
}

describe("then_run", () => {
	it("exposes then_run in the edit and write schemas", () => {
		const edit = createEditTool(process.cwd());
		const write = createWriteTool(process.cwd());
		expect(edit.parameters.properties).toHaveProperty("then_run");
		expect(write.parameters.properties).toHaveProperty("then_run");
	});

	it("runs the fused command after a successful write", async () => {
		const dir = await createTempDir();
		const write = createWriteTool(dir);
		const result = await write.execute("call-1", {
			path: "target.txt",
			content: "a\nb\na\n",
			then_run: { command: "grep -c a target.txt" },
		});

		const blocks = textBlocks(result);
		expect(blocks[0]).toContain("Successfully wrote to target.txt");
		expect(blocks[1]).toContain("[then_run] $ grep -c a target.txt");
		expect(blocks[1]).toContain("2");
		expect(result.details?.thenRun?.status).toBe("succeeded");
		expect(result.details?.thenRun?.exitCode).toBe(0);
	});

	it("runs the fused command after a successful edit", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "file.txt"), "hello world\n");
		const edit = createEditTool(dir);
		const result = await edit.execute("call-2", {
			path: "file.txt",
			edits: [{ oldText: "world", newText: "there" }],
			then_run: { command: "grep -c hello file.txt" },
		});

		const blocks = textBlocks(result);
		expect(blocks[0]).toContain("Successfully replaced 1 block(s) in file.txt");
		expect(blocks[1]).toContain("[then_run] $ grep -c hello file.txt");
		expect(blocks[1]).toContain("1");
		expect(result.details?.diff).toBeTruthy();
		expect(result.details?.thenRun?.status).toBe("succeeded");
	});

	it("keeps the mutation and reports the failure when the command exits non-zero", async () => {
		const dir = await createTempDir();
		const write = createWriteTool(dir);
		const call = write.execute("call-3", {
			path: "kept.txt",
			content: "kept\n",
			then_run: { command: "exit 3" },
		});

		await expect(call).rejects.toThrow(/exited with code 3/);
		await expect(call).rejects.toThrow(/Successfully wrote to kept\.txt/);
		await expect(call).rejects.toThrow(/\[then_run\] \$ exit 3/);
		expect(await readFile(join(dir, "kept.txt"), "utf8")).toBe("kept\n");
	});

	it("skips the command when the mutation fails", async () => {
		const dir = await createTempDir();
		const edit = createEditTool(dir);
		await expect(
			edit.execute("call-4", {
				path: "missing.txt",
				edits: [{ oldText: "a", newText: "b" }],
				then_run: { command: "touch side-effect.txt" },
			}),
		).rejects.toThrow(new RegExp(`${THEN_RUN_SKIPPED.replace(/[[\]]/g, "\\$&")}.*did not complete`, "s"));

		// The command never ran.
		await expect(readFile(join(dir, "side-effect.txt"))).rejects.toThrow();
	});

	it("skips the command without failing when the file changed on disk after the mutation", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "watched.txt");
		await writeFile(filePath, "original\n");

		// Second hash read returns tampered content, simulating an external writer
		// landing between the mutation and the fused command.
		let reads = 0;
		const operations: EditOperations = {
			readFile: async () => {
				reads++;
				const content = reads >= 3 ? "tampered\n" : "original\n";
				return Buffer.from(content, "utf8");
			},
			writeFile: async () => {},
			access: async () => {},
		};
		const edit = createEditTool(dir, { operations });
		const result = await edit.execute("call-5", {
			path: "watched.txt",
			edits: [{ oldText: "original", newText: "updated" }],
			then_run: { command: "touch side-effect.txt" },
		});

		expect(result.details?.thenRun?.status).toBe("skipped");
		expect(textBlocks(result)[1]).toContain(THEN_RUN_SKIPPED);
		expect(textBlocks(result)[1]).toContain("changed on disk");
		await expect(readFile(join(dir, "side-effect.txt"))).rejects.toThrow();
	});

	it("leaves results untouched when then_run is omitted", async () => {
		const dir = await createTempDir();
		const write = createWriteTool(dir);
		const result = await write.execute("call-6", { path: "plain.txt", content: "plain\n" });

		expect(result.content).toHaveLength(1);
		expect(textBlocks(result)[0]).toContain("Successfully wrote to plain.txt");
		expect(result.details).toBeUndefined();
	});
});
