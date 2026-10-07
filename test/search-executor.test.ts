import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
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

assert.equal(ex.readfile("/codebase/a.ts", 1, 2), "1:line1\n2:const token = auth();", "readfile range");

assert.equal(await ex.rg("token", "/codebase", null), "/codebase/a.ts:2:const token = auth();", "rg remap");
assert.ok(ex.collectedRgPatterns.includes("token"), "rg pattern collected");

{
	const out = ex.tree("/codebase", 1);
	assert.ok(out.startsWith("/codebase"), "tree root label");
	assert.ok(out.includes("a.ts") && out.includes("sub"), "tree entries");
}

{
	const out = ex.ls("/codebase", false, false);
	assert.ok(out.includes("a.ts") && out.includes("sub"), "ls entries");
	assert.ok(!out.includes(".hidden"), "ls hides dotfiles");
	assert.ok(ex.ls("/codebase", false, true).includes(".hidden"), "ls -a shows dotfiles");
}

{
	const out = ex.glob("**/*.ts", "/codebase", "file");
	assert.ok(out.includes("/codebase/a.ts"), "glob a.ts");
	assert.ok(out.includes("/codebase/sub/b.ts"), "glob sub/b.ts");
}

assert.match(ex.readfile("/codebase/../../etc/passwd", null, null), /outside project root/, "readfile escape");
assert.match(ex.tree("/etc", null), /outside project root/, "tree absolute escape");
assert.match(await ex.rg("xyz", "/codebase/../..", null), /outside project root/, "rg escape");

{
	const out = await ex.execToolCall({
		command1: { type: "readfile", file: "/codebase/a.ts", start_line: 1, end_line: 1 },
		command2: { type: "ls", path: "/codebase" },
	});
	assert.ok(out.includes("<command1_result>") && out.includes("</command1_result>"), "command1 wrapper");
	assert.ok(out.includes("<command2_result>"), "command2 wrapper");
	assert.ok(out.includes("1:line1"), "command1 output");
}

{
	const t = renderTree(root, "/codebase", { maxDepth: 2 });
	assert.equal(t.split("\n")[0], "/codebase", "renderTree root line");
	assert.ok(t.includes("a.ts") && t.includes("sub"), "renderTree entries");
}

console.log("OK executor self-test passed");

describe("search executor selftest", async () => {
	it("passes", async () => {});
});
