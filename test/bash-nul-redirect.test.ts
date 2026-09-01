import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBashOperations, normalizeLocalBashCommand } from "../src/core/tools/bash.ts";
import { rewriteCmdNulRedirects } from "../src/utils/shell.ts";

describe("rewriteCmdNulRedirects", () => {
	it("rewrites stderr redirects to nul", () => {
		expect(rewriteCmdNulRedirects("dir 2>nul")).toBe("dir 2>/dev/null");
	});

	it("rewrites stdout redirects to nul", () => {
		expect(rewriteCmdNulRedirects("dir >nul")).toBe("dir >/dev/null");
	});

	it("rewrites append redirects to nul", () => {
		expect(rewriteCmdNulRedirects("dir >>nul")).toBe("dir >>/dev/null");
	});

	it("rewrites combined redirects to nul", () => {
		expect(rewriteCmdNulRedirects("dir &>nul")).toBe("dir &>/dev/null");
	});

	it("rewrites explicit stdout file descriptors", () => {
		expect(rewriteCmdNulRedirects("dir 1>nul")).toBe("dir 1>/dev/null");
	});

	it("preserves whitespace between the redirect and nul", () => {
		expect(rewriteCmdNulRedirects("dir > nul")).toBe("dir > /dev/null");
		expect(rewriteCmdNulRedirects("dir 2>  nul")).toBe("dir 2>  /dev/null");
	});

	it("matches nul case-insensitively", () => {
		expect(rewriteCmdNulRedirects("dir 2>NUL")).toBe("dir 2>/dev/null");
		expect(rewriteCmdNulRedirects("dir > Nul")).toBe("dir > /dev/null");
	});

	it("keeps a following stderr duplication intact", () => {
		expect(rewriteCmdNulRedirects("dir > nul 2>&1")).toBe("dir > /dev/null 2>&1");
	});

	it("rewrites before shell metacharacters", () => {
		expect(rewriteCmdNulRedirects("dir 2>nul; echo done")).toBe("dir 2>/dev/null; echo done");
		expect(rewriteCmdNulRedirects("dir 2>nul|wc -l")).toBe("dir 2>/dev/null|wc -l");
		expect(rewriteCmdNulRedirects("dir 2>nul&&echo ok")).toBe("dir 2>/dev/null&&echo ok");
		expect(rewriteCmdNulRedirects("(dir 2>nul)")).toBe("(dir 2>/dev/null)");
	});

	it("rewrites every occurrence in multi-line commands", () => {
		expect(rewriteCmdNulRedirects("dir 2>nul\nwhere git >nul 2>nul")).toBe(
			"dir 2>/dev/null\nwhere git >/dev/null 2>/dev/null",
		);
	});

	it("leaves longer tokens starting with nul untouched", () => {
		expect(rewriteCmdNulRedirects("dir >null")).toBe("dir >null");
		expect(rewriteCmdNulRedirects("dir 2>nul.txt")).toBe("dir 2>nul.txt");
		expect(rewriteCmdNulRedirects("dir >nullable")).toBe("dir >nullable");
	});

	it("leaves nul outside a redirect untouched", () => {
		expect(rewriteCmdNulRedirects("cat nul")).toBe("cat nul");
		expect(rewriteCmdNulRedirects("echo nul")).toBe("echo nul");
		expect(rewriteCmdNulRedirects("rm nul")).toBe("rm nul");
	});

	it("leaves input redirects from nul untouched", () => {
		// `<nul` fails with "No such file or directory" but never creates a file.
		expect(rewriteCmdNulRedirects("certutil -encode a b <nul")).toBe("certutil -encode a b <nul");
	});

	it("leaves POSIX null redirects untouched", () => {
		expect(rewriteCmdNulRedirects("dir 2>/dev/null")).toBe("dir 2>/dev/null");
	});

	it("rewrites inside quoted strings when nul ends like a redirect token", () => {
		// The regex does not parse shell quoting. A quoted `2>nul` followed by
		// whitespace is rewritten — rare and harmless, documented trade-off.
		expect(rewriteCmdNulRedirects('echo "dir 2>nul crashes"')).toBe('echo "dir 2>/dev/null crashes"');
	});

	it("leaves quoted nul directly followed by the closing quote untouched", () => {
		// The lookahead requires whitespace or a shell metacharacter after
		// `nul`, so a closing quote right behind it prevents the rewrite.
		expect(rewriteCmdNulRedirects('echo "dir 2>nul"')).toBe('echo "dir 2>nul"');
	});

	it("only applies the compatibility rewrite to native Windows commands", () => {
		expect(normalizeLocalBashCommand("echo ok 2>nul", "win32")).toBe("echo ok 2>/dev/null");
		expect(normalizeLocalBashCommand("echo ok 2>nul", "linux")).toBe("echo ok 2>nul");
		expect(normalizeLocalBashCommand("echo ok 2>nul", "darwin")).toBe("echo ok 2>nul");
	});
});

describe("bash tool nul redirect integration", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-nul-redirect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (!existsSync(testDir)) return;
		// If the rewrite ever regresses, a literal `nul` entry appears here. On
		// Windows that reserved device name can only be deleted through the
		// `\\?\` prefix, so remove it explicitly before the recursive cleanup.
		if (readdirSync(testDir).includes("nul")) {
			const nulPath = join(testDir, "nul");
			rmSync(process.platform === "win32" ? `\\\\?\\${nulPath}` : nulPath, { force: true });
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it.skipIf(process.platform !== "win32")("does not create a literal nul file for CMD-style redirects", async () => {
		const ops = createLocalBashOperations();
		let output = "";
		const { exitCode } = await ops.exec("echo ok 2>nul >nul; echo visible 2> nul", testDir, {
			onData: (data) => {
				output += data.toString("utf-8");
			},
		});

		expect(exitCode).toBe(0);
		expect(output).toContain("visible");
		expect(output).not.toContain("ok");
		// existsSync cannot be used here: on Windows any path ending in `nul`
		// resolves to the NUL device and always reports as existing.
		expect(readdirSync(testDir)).not.toContain("nul");
	});

	it.skipIf(process.platform === "win32")("preserves ordinary POSIX files named nul", async () => {
		const ops = createLocalBashOperations();
		const { exitCode } = await ops.exec("printf ordinary >nul", testDir, { onData: () => {} });

		expect(exitCode).toBe(0);
		expect(readdirSync(testDir)).toContain("nul");
	});
});
