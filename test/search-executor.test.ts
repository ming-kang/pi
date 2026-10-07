import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type GrepFn, ToolExecutor } from "../src/extensions/search/executor.ts";
import { PathSandbox } from "../src/extensions/search/sandbox.ts";
import { renderTree } from "../src/extensions/search/tree.ts";

const root = mkdtempSync(join(tmpdir(), "fc-exec-"));
mkdirSync(join(root, "sub"), { recursive: true });
mkdirSync(join(root, "node_modules"), { recursive: true });
writeFileSync(join(root, "a.ts"), "line1\nconst token = auth();\nline3\n");
writeFileSync(join(root, "sub", "b.ts"), "export const b = 1;\n");
writeFileSync(join(root, ".hidden"), "secret\n");
writeFileSync(join(root, "node_modules", "junk.js"), "junk\n");

const sandbox = new PathSandbox(root);
const fakeGrep: GrepFn = async (pattern) => `a.ts:2:const ${pattern} = auth();`;
const ex = new ToolExecutor(sandbox, fakeGrep);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ToolExecutor.readfile", () => {
	it("numbers the requested line range", () => {
		expect(ex.readfile("/codebase/a.ts", 1, 2)).toBe("1:line1\n2:const token = auth();");
	});
});

describe("ToolExecutor.rg", () => {
	it("remaps hits onto the virtual root and collects the pattern", async () => {
		expect(await ex.rg("token", "/codebase", null)).toBe("/codebase/a.ts:2:const token = auth();");
		expect(ex.collectedRgPatterns).toContain("token");
	});
});

describe("ToolExecutor.tree", () => {
	it("labels the root and lists entries", () => {
		const out = ex.tree("/codebase", 1);
		expect(out.startsWith("/codebase")).toBe(true);
		expect(out).toContain("a.ts");
		expect(out).toContain("sub");
	});
});

describe("ToolExecutor.ls", () => {
	it("hides dotfiles unless `all` is set", () => {
		const out = ex.ls("/codebase", false, false);
		expect(out).toContain("a.ts");
		expect(out).toContain("sub");
		expect(out).not.toContain(".hidden");
		expect(ex.ls("/codebase", false, true)).toContain(".hidden");
	});
});

describe("ToolExecutor.glob", () => {
	it("matches recursively on **", () => {
		const out = ex.glob("**/*.ts", "/codebase", "file");
		expect(out).toContain("/codebase/a.ts");
		expect(out).toContain("/codebase/sub/b.ts");
	});
});

describe("path escapes", () => {
	it("refuses every command whose path leaves the root", async () => {
		expect(ex.readfile("/codebase/../../etc/passwd", null, null)).toMatch(/outside project root/);
		expect(ex.tree("/etc", null)).toMatch(/outside project root/);
		expect(await ex.rg("xyz", "/codebase/../..", null)).toMatch(/outside project root/);
	});
});

describe("ToolExecutor.execToolCall", () => {
	it("wraps each command result in its own tag", async () => {
		const out = await ex.execToolCall({
			command1: { type: "readfile", file: "/codebase/a.ts", start_line: 1, end_line: 1 },
			command2: { type: "ls", path: "/codebase" },
		});
		expect(out).toContain("<command1_result>");
		expect(out).toContain("</command1_result>");
		expect(out).toContain("<command2_result>");
		expect(out).toContain("1:line1");
	});
});

describe("renderTree", () => {
	it("starts at the label and lists entries", () => {
		const t = renderTree(root, "/codebase", { maxDepth: 2 });
		expect(t.split("\n")[0]).toBe("/codebase");
		expect(t).toContain("a.ts");
		expect(t).toContain("sub");
	});
});
