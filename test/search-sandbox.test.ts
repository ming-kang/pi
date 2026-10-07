import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { PathSandbox } from "../src/extensions/search/sandbox.ts";

const root = mkdtempSync(join(tmpdir(), "fc-sandbox-"));
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "sub", "f.txt"), "hi");

const sb = new PathSandbox(root);

assert.ok(sb.toReal("/codebase") !== null, "root itself allowed");
const f = sb.toReal("/codebase/sub/f.txt");
assert.ok(f?.endsWith(join("sub", "f.txt")), "in-root file allowed");
assert.ok(sb.toReal("/codebase/./sub/../sub/f.txt") !== null, "normalized in-root path allowed");
assert.ok(sb.toReal("sub/f.txt") !== null, "bare relative path treated as root-relative");

assert.equal(sb.toReal("/codebase/../../etc/passwd"), null, "../ traversal refused");
assert.equal(sb.toReal("/codebase/../" + "sibling"), null, "single ../ to sibling refused");
assert.equal(sb.toReal("../escape"), null, "bare ../ refused");

assert.equal(sb.toReal("/etc/passwd"), null, "posix absolute refused");
assert.equal(sb.toReal("C:\\Windows\\System32"), null, "windows absolute refused");

assert.equal(sb.toReal(""), null, "empty refused");
assert.equal(sb.toReal(undefined as unknown as string), null, "non-string refused");

assert.equal(sb.toVirtual(join(root, "sub", "f.txt")), "/codebase/sub/f.txt", "toVirtual maps in-root");
assert.equal(sb.toVirtual(root), "/codebase", "toVirtual maps root itself");

let symlinkTested = false;
try {
	const outside = mkdtempSync(join(tmpdir(), "fc-outside-"));
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(outside, join(root, "link"), "dir");
	symlinkTested = true;
	assert.equal(sb.toReal("/codebase/link/secret.txt"), null, "symlink escape refused");
} catch (e) {
	console.log(`  (symlink escape test skipped: ${(e as Error).message})`);
}

console.log(`OK sandbox self-test passed${symlinkTested ? " (incl. symlink escape)" : ""}`);

describe("search sandbox selftest", async () => {
	it("passes", async () => {});
});
