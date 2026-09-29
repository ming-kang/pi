import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExploreTools, resolveExploreScope } from "../src/extensions/explore/scope.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-explore-scope-"));
	await mkdir(join(root, "src"));
	await mkdir(join(root, "outside"));
	await writeFile(join(root, "src", "entry.ts"), "export const answer = 42;");
	await writeFile(join(root, "outside", "secret.ts"), "PRIVATE_MARKER");
	await symlink(join(root, "outside"), join(root, "src", "link"), "junction");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

describe("Explore read scope", () => {
	it("does not let a ripgrep configuration enable traversal through links", async () => {
		const config = join(root, "rg-config");
		await writeFile(config, "--follow\n");
		vi.stubEnv("RIPGREP_CONFIG_PATH", config);
		const tools = createExploreTools(root, await resolveExploreScope(root, "src"));
		const result = await tools[1]!.execute("search", { pattern: "PRIVATE_MARKER|answer" });
		expect(JSON.stringify(result.content)).toContain("answer = 42");
		expect(JSON.stringify(result.content)).not.toContain("PRIVATE_MARKER");
	});
	it("keeps only four tools and rejects traversal and linked reads", async () => {
		const scope = await resolveExploreScope(root, "src");
		const tools = createExploreTools(root, scope);
		expect(tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
		const read = tools[0]!;
		expect((await read.execute("read", { path: "src/entry.ts" })).content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("answer = 42") })]),
		);
		await expect(read.execute("escape", { path: "outside/secret.ts" })).rejects.toThrow(/scope/i);
		await expect(read.execute("link", { path: "src/link/secret.ts" })).rejects.toThrow(/scope/i);
	});
	it("defaults searches to the scope and does not follow directory links", async () => {
		const tools = createExploreTools(root, await resolveExploreScope(root, "src"));
		const result = await tools[1]!.execute("search", { pattern: "PRIVATE_MARKER|answer" });
		const text = JSON.stringify(result.content);
		expect(text).toContain("answer = 42");
		expect(text).not.toContain("PRIVATE_MARKER");
	});
	it("supports a single file scope and rejects a root outside cwd", async () => {
		const scope = await resolveExploreScope(root, "src/entry.ts");
		const tools = createExploreTools(root, scope);
		await expect(tools[0]!.execute("read", { path: "src/entry.ts" })).resolves.toBeDefined();
		await expect(tools[3]!.execute("list", { path: "src" })).rejects.toThrow(/scope/i);
		await expect(resolveExploreScope(root, "..")).rejects.toThrow(/scope/i);
	});
});
