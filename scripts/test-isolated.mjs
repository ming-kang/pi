#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix as posixPath, resolve, win32 as win32Path } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

const root = resolve(import.meta.dirname, "..");

export function getManagedBinDirectory(
	environment = process.env,
	platform = process.platform,
	directoryExists = existsSync,
) {
	const candidates = [];
	const pathApi = platform === "win32" ? win32Path : posixPath;
	if (environment.PI_CODING_AGENT_DIR?.trim()) {
		candidates.push(pathApi.resolve(environment.PI_CODING_AGENT_DIR, "bin"));
	}
	const home =
		platform === "win32"
			? (environment.USERPROFILE ?? environment.HOME)
			: (environment.HOME ?? environment.USERPROFILE);
	if (home) candidates.push(pathApi.join(home, ".pi", "agent", "bin"));
	return candidates.find((candidate) => directoryExists(candidate));
}

export function buildIsolatedPath(pathValue, managedBin, platform = process.platform) {
	const pathDelimiter = platform === "win32" ? ";" : ":";
	const entries = (pathValue ?? "")
		.split(pathDelimiter)
		.filter(Boolean)
		.filter((entry) => platform !== "win32" || !entry.replaceAll("/", "\\").toLowerCase().includes("\\windowsapps"));
	if (managedBin) entries.unshift(managedBin);

	const seen = new Set();
	return entries
		.filter((entry) => {
			const key = platform === "win32" ? entry.replaceAll("/", "\\").toLowerCase() : entry;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.join(pathDelimiter);
}

export function findMissingRequiredTools(commandExists) {
	const missing = [];
	if (!["fd", "fdfind"].some((command) => commandExists(command))) missing.push("fd (or fdfind)");
	if (!commandExists("rg")) missing.push("rg");
	return missing;
}

function canRun(command, environment) {
	const result = spawn.sync(command, ["--version"], { env: environment, stdio: "ignore" });
	return (result.error === undefined || result.error === null) && result.status === 0;
}

export function runIsolatedTests() {
	const isWindows = process.platform === "win32";
	const managedBin = getManagedBinDirectory(process.env, process.platform);
	const isolatedPath = buildIsolatedPath(process.env.PATH, managedBin, process.platform);

	// Isolate user resources, credentials, temporary files, and tool configuration.
	const testRoot = mkdtempSync(join(tmpdir(), "pi-test-"));
	try {
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
			PATH: isolatedPath,
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

		const missingTools = findMissingRequiredTools((command) => canRun(command, environment));
		if (missingTools.length > 0) {
			console.error(
				`Cannot run isolated tests because the isolated PATH is missing: ${missingTools.join(", ")}. ` +
					"Install them or let Pi install its managed copies before retrying.",
			);
			return 1;
		}

		console.log(`Running tests without API keys in isolated home: ${join(testRoot, "home")}`);
		const result = spawn.sync("npm", ["test"], { cwd: root, env: environment, stdio: "inherit" });
		if (result.error) {
			console.error(`Failed to start npm test: ${result.error.message}`);
			return 1;
		}
		if (result.signal) {
			console.error(`npm test terminated by signal ${result.signal}.`);
			return 1;
		}
		return result.status ?? 1;
	} finally {
		rmSync(testRoot, { recursive: true, force: true });
	}
}

const mainPath = process.argv[1] && resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
const isMain =
	mainPath &&
	(process.platform === "win32" ? mainPath.toLowerCase() === modulePath.toLowerCase() : mainPath === modulePath);

if (isMain) {
	process.exitCode = runIsolatedTests();
}
