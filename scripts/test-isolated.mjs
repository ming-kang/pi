#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import spawn from "cross-spawn";

const root = resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";

// Isolate user resources, credentials, temporary files, and tool configuration.
const testRoot = mkdtempSync(join(tmpdir(), "pi-test-"));
mkdirSync(join(testRoot, "home", ".config"), { recursive: true });
mkdirSync(join(testRoot, "tmp"), { recursive: true });
mkdirSync(join(testRoot, "cache", "npm"), { recursive: true });
writeFileSync(join(testRoot, "npm-userconfig"), "");
writeFileSync(join(testRoot, "npm-globalconfig"), "");

// A failing askpass helper prevents git credential prompts inside tests.
const askpass = join(testRoot, isWindows ? "git-askpass.bat" : "git-askpass.sh");
writeFileSync(askpass, isWindows ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
if (!isWindows) chmodSync(askpass, 0o755);

// Start from an empty environment and allow only required platform and test settings.
const environment = {
	PATH: process.env.PATH,
	PWD: process.cwd(),
	HOME: join(testRoot, "home"),
	USERPROFILE: join(testRoot, "home"),
	TMPDIR: join(testRoot, "tmp"),
	TMP: join(testRoot, "tmp"),
	TEMP: join(testRoot, "tmp"),
	XDG_CONFIG_HOME: join(testRoot, "home", ".config"),
	XDG_CACHE_HOME: join(testRoot, "cache"),
	LANG: "C",
	LC_ALL: "C",
	TZ: "UTC",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: isWindows ? "nul" : "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: askpass,
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	NPM_CONFIG_USERCONFIG: join(testRoot, "npm-userconfig"),
	NPM_CONFIG_GLOBALCONFIG: join(testRoot, "npm-globalconfig"),
	NPM_CONFIG_CACHE: join(testRoot, "cache", "npm"),
	PI_NO_LOCAL_LLM: "1",
	AWS_EC2_METADATA_DISABLED: "true",
};

// Native Windows needs these inherited values to launch child processes.
for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
	if (process.env[name]) environment[name] = process.env[name];
}

// Preserve CI detection only for runner behavior and test reporting.
for (const name of ["CI", "GITHUB_ACTIONS"]) {
	if (process.env[name]) environment[name] = process.env[name];
}

console.log(`Running tests without API keys in isolated home: ${join(testRoot, "home")}`);
const result = spawn.sync("npm", ["test"], { cwd: root, env: environment, stdio: "inherit" });
rmSync(testRoot, { recursive: true, force: true });
process.exit(result.signal ? 1 : (result.status ?? 1));
