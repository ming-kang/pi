#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { createSourceEnvironment } from "./run-source.mjs";

const [installSpec, expectedVersionArgument] = process.argv.slice(2);
if (!installSpec) {
	console.error("Usage: node scripts/verify-package-install.mjs <tarball-or-package-spec> [expected-version]");
	process.exit(1);
}

const sourcePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedVersion = expectedVersionArgument ?? sourcePackage.version;
const expectedRuntimePackages = Object.keys(sourcePackage.dependencies);
const sourceExtensionsDirectory = new URL("../src/extensions/", import.meta.url);
const expectedExtensionEntrypoints = readdirSync(sourceExtensionsDirectory, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isDirectory() &&
			existsSync(new URL(`${encodeURIComponent(entry.name)}/index.ts`, sourceExtensionsDirectory)),
	)
	.map((entry) => `dist/extensions/${entry.name}/index.js`)
	.sort();
const installPath = resolve(process.cwd(), installSpec);
const installDirectory = mkdtempSync(join(tmpdir(), "astralyn-pi-package-smoke-"));
const packageDirectory = join(installDirectory, "node_modules", "@astralyn", "pi");
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
	throw new Error("Run this verifier through `npm run verify:package-install -- <package-spec>`.");
}
const smokeEnvironment = {
	...createSourceEnvironment(process.env, true),
	HOME: installDirectory,
	USERPROFILE: installDirectory,
	XDG_CONFIG_HOME: join(installDirectory, "config"),
	XDG_CACHE_HOME: join(installDirectory, "cache"),
	PI_CODING_AGENT_DIR: join(installDirectory, "agent"),
	PI_CODING_AGENT_SESSION_DIR: join(installDirectory, "sessions"),
	PI_EXPERIMENTAL: "1",
	NO_COLOR: "1",
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	...(process.env.PI_PACKAGE_ALLOW_FRESH === "1" ? { npm_config_min_release_age: "0" } : {}),
	npm_config_audit: "false",
	npm_config_fund: "false",
	npm_config_update_notifier: "false",
};
// npm run exports the caller's allow-scripts policy as an environment option,
// which newer npm versions reject for a different project. This installation
// already disables all lifecycle scripts explicitly with --ignore-scripts.
delete smokeEnvironment.npm_config_allow_scripts;

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

function readTarballManifest(tarball) {
	const archive = gunzipSync(tarball);
	const readField = (header, start, end) => header.toString("utf8", start, end).replace(/\0.*$/s, "").trim();
	for (let offset = 0; offset + 512 <= archive.length; ) {
		const header = archive.subarray(offset, offset + 512);
		const entryName = readField(header, 0, 100);
		if (!entryName) {
			break;
		}
		const size = Number.parseInt(readField(header, 124, 136), 8);
		if (entryName === "package/package.json") {
			return JSON.parse(archive.toString("utf8", offset + 512, offset + 512 + size));
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	throw new Error(`${installSpec} has no package/package.json.`);
}

// npm applies a package's npm-shrinkwrap.json only when it installs that package
// from a registry, which nests the locked dependencies below the package; a
// tarball path installs them flat instead. Serve a tarball from a loopback
// registry for its scope so it installs exactly as users install the release.
async function serveTarball(tarball) {
	const bytes = readFileSync(tarball);
	const manifest = readTarballManifest(bytes);
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	const server = createServer((request, response) => {
		const origin = `http://127.0.0.1:${server.address().port}`;
		if (decodeURIComponent(request.url ?? "") === `/${manifest.name}`) {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					name: manifest.name,
					"dist-tags": { latest: manifest.version },
					versions: {
						[manifest.version]: {
							...manifest,
							_hasShrinkwrap: true,
							dist: { tarball: `${origin}/package.tgz`, integrity },
						},
					},
				}),
			);
		} else if (request.url === "/package.tgz") {
			response.end(bytes);
		} else {
			response.statusCode = 404;
			response.end();
		}
	});
	await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const scope = manifest.name.split("/")[0];
	return {
		installArguments: [
			`--${scope}:registry=http://127.0.0.1:${server.address().port}/`,
			`${manifest.name}@${manifest.version}`,
		],
		close: () => server.close(),
	};
}

async function installPackage() {
	const registry = existsSync(installPath) ? await serveTarball(installPath) : undefined;
	try {
		const npm = spawn(
			process.execPath,
			[
				npmCliPath,
				"install",
				"--omit=dev",
				"--ignore-scripts",
				"--save-exact",
				...(registry?.installArguments ?? [installSpec]),
			],
			{ cwd: installDirectory, env: smokeEnvironment, stdio: "inherit" },
		);
		const [exitCode] = await once(npm, "close");
		if (exitCode !== 0) {
			throw new Error(`npm install ${installSpec} exited with code ${exitCode}.`);
		}
	} finally {
		registry?.close();
	}
}

async function verifyInstallation() {
	try {
		writeFileSync(
			join(installDirectory, "package.json"),
			JSON.stringify({ name: "astralyn-pi-package-smoke", version: "1.0.0", private: true }, null, 2),
		);

		await installPackage();

		const installedPackage = readInstalledPackage("@astralyn/pi");
		assertEqual(installedPackage.name, "@astralyn/pi", "installed package name");
		assertEqual(installedPackage.version, expectedVersion, "installed package version");
		assertEqual(installedPackage.bin?.pi, "dist/bundle/cli.js", "installed pi binary target");
		assertEqual(
			installedPackage.exports?.["./rpc-entry"]?.import,
			"./dist/bundle/rpc-entry.js",
			"installed RPC export target",
		);
		for (const [subpath, source] of [
			["./client", "./src/client/index.ts"],
			["./experimental/plugin", "./src/experimental/plugin.ts"],
		]) {
			const entry = installedPackage.exports?.[subpath];
			assertEqual(entry?.source, source, `${subpath} source target`);
			assertEqual(Object.keys(entry).join(","), "source", `${subpath} export conditions`);
		}

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
			"dist/bundle/cli.js",
			"dist/bundle/index.js",
			"dist/index.d.ts",
			"dist/index.js",
			"dist/bundle/rpc-entry.js",
			"dist/core/export-html/template.html",
			...expectedExtensionEntrypoints,
			"dist/modes/interactive/assets/clankolas.png",
			"dist/modes/interactive/theme/dark.json",
			"dist/modes/interactive/theme/ice-cream-dark.json",
			"dist/modes/interactive/theme/ice-cream-light.json",
			"dist/modes/interactive/theme/light.json",
			"docs/bundled/README.md",
			"docs/bundled/tasks.md",
			"docs/bundled/extensions/deepwiki.md",
			"docs/bundled/extensions/question.md",
			"docs/bundled/extensions/provider.md",
			"docs/bundled/extensions/statusline.md",
			"docs/bundled/extensions/search.md",
			"docs/bundled/themes.md",
			"docs/bundled/tool-presentation.md",
			"docs/docs.json",
			"docs/llama-cpp.md",
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

		const bundledCliPath = join(packageDirectory, "dist", "bundle", "cli.js");
		for (const entrypoint of ["cli.js", "rpc-entry.js"]) {
			if (
				!readFileSync(join(packageDirectory, "dist", "bundle", entrypoint), "utf8").startsWith(
					"#!/usr/bin/env node",
				)
			) {
				throw new Error(`Installed bundled ${entrypoint} is missing its shebang.`);
			}
		}
		for (const forbiddenPath of [
			"dist/client",
			"dist/experimental",
			"dist/cli/experimental",
			"dist/extensions/biu",
			"dist/extensions/explore",
			"dist/extensions/plan",
			"dist/extensions/rewind",
			"dist/extensions/subagent",
			"dist/extensions/todo",
			"docs/bundled/extensions/biu.md",
			"docs/bundled/extensions/explore.md",
			"docs/bundled/extensions/plan.md",
			"docs/bundled/extensions/rewind.md",
			"docs/bundled/extensions/subagent.md",
			"docs/bundled/extensions/todo.md",
			"examples/extensions/todo.ts",
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

		const listModelsArguments =
			process.platform === "win32" ? ["/d", "/s", "/c", `""${installedBinPath}" --list-models"`] : ["--list-models"];
		const listedModels = execFileSync(cliCommand, listModelsArguments, {
			cwd: installDirectory,
			encoding: "utf8",
			env: smokeEnvironment,
			windowsVerbatimArguments: process.platform === "win32",
		}).trim();
		if (!listedModels) {
			throw new Error("CLI --list-models returned no output.");
		}

		const importCheckPath = join(installDirectory, "verify-imports.mjs");
		writeFileSync(
			importCheckPath,
			`import assert from "node:assert/strict";
import { createAgentSession } from "@astralyn/pi";

assert.equal(typeof createAgentSession, "function");
for (const subpath of ["@astralyn/pi/client", "@astralyn/pi/experimental/plugin"]) {
	assert.throws(() => import.meta.resolve(subpath), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
`,
		);
		execFileSync(process.execPath, [importCheckPath], {
			cwd: installDirectory,
			env: smokeEnvironment,
			stdio: "inherit",
		});

		for (const fixture of ["package-bundle-extension.ts", "package-bundle-runtime.mjs"]) {
			copyFileSync(new URL(`../test/fixtures/${fixture}`, import.meta.url), join(installDirectory, fixture));
		}
		execFileSync(process.execPath, [join(installDirectory, "package-bundle-runtime.mjs")], {
			cwd: installDirectory,
			env: smokeEnvironment,
			stdio: "inherit",
			timeout: 60_000,
			windowsHide: true,
		});

		const stableVersion = execFileSync(
			process.execPath,
			[bundledCliPath, "server", "--server-id", "invalid", "--version"],
			{ cwd: installDirectory, encoding: "utf8", env: smokeEnvironment },
		).trim();
		assertEqual(stableVersion, expectedVersion, "published CLI ignores development-only server dispatch");
		const rpcVersion = execFileSync(
			process.execPath,
			[join(packageDirectory, "dist", "bundle", "rpc-entry.js"), "--version"],
			{
				cwd: installDirectory,
				encoding: "utf8",
				env: smokeEnvironment,
			},
		).trim();
		assertEqual(rpcVersion, expectedVersion, "RPC entrypoint version");

		console.log(`Verified clean installation of @astralyn/pi@${expectedVersion} from ${installSpec}.`);
	} catch (error) {
		// The installed artifact failed a content check: surface it as an Actions
		// error annotation before the uncaught exception marks the failure.
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		throw error;
	} finally {
		rmSync(installDirectory, { force: true, recursive: true });
	}
}

await verifyInstallation();
