import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PathSandbox } from "../src/extensions/search/sandbox.ts";

const root = mkdtempSync(join(tmpdir(), "fc-sandbox-"));
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "sub", "f.txt"), "hi");
const sb = new PathSandbox(root);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("PathSandbox.toReal", () => {
	it("resolves the root, in-root files, and root-relative paths", () => {
		expect(sb.toReal("/codebase")).not.toBeNull();
		expect(sb.toReal("/codebase/sub/f.txt")?.endsWith(join("sub", "f.txt"))).toBe(true);
		expect(sb.toReal("/codebase/./sub/../sub/f.txt")).not.toBeNull();
		expect(sb.toReal("sub/f.txt")).not.toBeNull();
	});

	it("refuses traversal, absolute paths, and junk input", () => {
		expect(sb.toReal("/codebase/../../etc/passwd")).toBeNull();
		expect(sb.toReal("/codebase/../sibling")).toBeNull();
		expect(sb.toReal("../escape")).toBeNull();
		expect(sb.toReal("/etc/passwd")).toBeNull();
		expect(sb.toReal(String.raw`C:\Windows\System32`)).toBeNull();
		expect(sb.toReal("")).toBeNull();
		expect(sb.toReal(undefined as unknown as string)).toBeNull();
	});

	it("refuses a symlink that points outside the root", () => {
		const outside = mkdtempSync(join(tmpdir(), "fc-outside-"));
		try {
			writeFileSync(join(outside, "secret.txt"), "secret");
			symlinkSync(outside, join(root, "link"), "dir");
		} catch {
			return; // unprivileged Windows sessions cannot create symlinks
		}
		expect(sb.toReal("/codebase/link/secret.txt")).toBeNull();
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("PathSandbox.toVirtual", () => {
	it("maps in-root paths back onto the virtual root", () => {
		expect(sb.toVirtual(join(root, "sub", "f.txt"))).toBe("/codebase/sub/f.txt");
		expect(sb.toVirtual(root)).toBe("/codebase");
	});
});
