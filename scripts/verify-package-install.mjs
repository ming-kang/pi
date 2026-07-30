#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const [installSpec, expectedVersionArgument] = process.argv.slice(2);
if (!installSpec) {
	console.error("Usage: node scripts/verify-package-install.mjs <tarball-or-package-spec> [expected-version]");
	process.exit(1);
}

const sourcePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedVersion = expectedVersionArgument ?? sourcePackage.version;
const expectedRuntimePackages = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"];
const installPath = resolve(process.cwd(), installSpec);
const resolvedInstallSpec = existsSync(installPath) ? installPath : installSpec;
const installDirectory = mkdtempSync(join(tmpdir(), "astralyn-pi-package-smoke-"));
const packageDirectory = join(installDirectory, "node_modules", "@astralyn", "pi");
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
	throw new Error("Run this verifier through `npm run verify:package-install -- <package-spec>`.");
}
const smokeEnvironment = {
	...process.env,
	NO_COLOR: "1",
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	...(process.env.PI_PACKAGE_ALLOW_FRESH === "1" ? { npm_config_min_release_age: "0" } : {}),
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
};

function readInstalledPackage(packageName) {
	const packageSegments = packageName.split("/");
	const rootCandidate = join(installDirectory, "node_modules", ...packageSegments, "package.json");
	const nestedCandidate = join(packageDirectory, "node_modules", ...packageSegments, "package.json");
	const candidates = packageName === "@astralyn/pi" ? [rootCandidate] : [nestedCandidate, rootCandidate];
	const packageJsonPath = candidates.find((candidate) => existsSync(candidate));
	if (!packageJsonPath) {
		throw new Error(`Installed package cannot resolve its runtime dependency ${packageName}.`);
	}
	return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function assertEqual(actual, expected, description) {
	if (actual !== expected) {
		throw new Error(`${description}: expected ${expected}, got ${actual}`);
	}
}

try {
	writeFileSync(
		join(installDirectory, "package.json"),
		JSON.stringify({ name: "astralyn-pi-package-smoke", version: "1.0.0", private: true }, null, 2),
	);

	execFileSync(process.execPath, [npmCliPath, "install", "--ignore-scripts", "--save-exact", resolvedInstallSpec], {
		cwd: installDirectory,
		env: smokeEnvironment,
		stdio: "inherit",
	});

	const installedPackage = readInstalledPackage("@astralyn/pi");
	assertEqual(installedPackage.name, "@astralyn/pi", "installed package name");
	assertEqual(installedPackage.version, expectedVersion, "installed package version");
	assertEqual(installedPackage.bin?.pi, "dist/cli.js", "installed pi binary target");
	assertEqual(installedPackage.exports?.["./rpc-entry"]?.import, "./dist/rpc-entry.js", "installed RPC export target");

	for (const packageName of expectedRuntimePackages) {
		const expectedDependencyVersion = installedPackage.dependencies?.[packageName];
		if (!expectedDependencyVersion) {
			throw new Error(`Root package is missing the required runtime dependency ${packageName}.`);
		}
		assertEqual(readInstalledPackage(packageName).version, expectedDependencyVersion, `${packageName} version`);
	}

	const requiredFiles = [
		"CHANGELOG.md",
		"LICENSE",
		"README.md",
		"dist/cli.js",
		"dist/index.d.ts",
		"dist/index.js",
		"dist/rpc-entry.js",
		"dist/core/export-html/template.html",
		"dist/extensions/deepwiki/index.js",
		"dist/extensions/llama/index.js",
		"dist/extensions/question/index.js",
		"dist/extensions/rewind/index.js",
		"dist/extensions/router/index.js",
		"dist/extensions/statusline/index.js",
		"dist/extensions/subagent/index.js",
		"dist/extensions/todo/index.js",
		"dist/modes/interactive/assets/clankolas.png",
		"dist/modes/interactive/theme/dark.json",
		"dist/modes/interactive/theme/ice-cream-dark.json",
		"dist/modes/interactive/theme/ice-cream-light.json",
		"dist/modes/interactive/theme/light.json",
		"docs/bundled/README.md",
		"docs/bundled/extensions/deepwiki.md",
		"docs/bundled/extensions/question.md",
		"docs/bundled/extensions/rewind.md",
		"docs/bundled/extensions/router.md",
		"docs/bundled/extensions/statusline.md",
		"docs/bundled/extensions/subagent.md",
		"docs/bundled/extensions/todo.md",
		"docs/bundled/themes.md",
		"docs/bundled/tool-presentation.md",
		"docs/docs.json",
		"docs/index.md",
		"examples/sdk/01-minimal.ts",
		"examples/sdk/README.md",
		"npm-shrinkwrap.json",
	];
	for (const relativePath of requiredFiles) {
		const requiredPath = join(packageDirectory, ...relativePath.split("/"));
		if (!existsSync(requiredPath) || !statSync(requiredPath).isFile()) {
			throw new Error(`Installed package is missing ${relativePath}.`);
		}
	}
	for (const forbiddenPath of [
		"dist/extensions/plan",
		"docs/bundled/extensions/plan.md",
		"examples/extensions/plan-mode",
		"maintainers",
		"node_modules/.package-lock.json",
		"packages",
		"src",
		"test",
	]) {
		if (existsSync(join(packageDirectory, ...forbiddenPath.split("/")))) {
			throw new Error(`Installed package unexpectedly contains ${forbiddenPath}.`);
		}
	}

	const installedBinPath = join(
		installDirectory,
		"node_modules",
		".bin",
		process.platform === "win32" ? "pi.cmd" : "pi",
	);
	if (!existsSync(installedBinPath)) {
		throw new Error("npm did not create the pi executable in node_modules/.bin.");
	}
	const cliCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : installedBinPath;
	const cliArguments =
		process.platform === "win32" ? ["/d", "/s", "/c", `""${installedBinPath}" --version"`] : ["--version"];
	const cliVersion = execFileSync(cliCommand, cliArguments, {
		cwd: installDirectory,
		encoding: "utf8",
		env: smokeEnvironment,
		windowsVerbatimArguments: process.platform === "win32",
	}).trim();
	assertEqual(cliVersion, expectedVersion, "CLI version");

	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'const api = await import("@astralyn/pi"); if (typeof api.createAgentSession !== "function") throw new Error("createAgentSession export missing");',
		],
		{ cwd: installDirectory, env: smokeEnvironment, stdio: "inherit" },
	);

	console.log(`Verified clean installation of @astralyn/pi@${expectedVersion} from ${resolvedInstallSpec}.`);
} finally {
	rmSync(installDirectory, { force: true, recursive: true });
}
