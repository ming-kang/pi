#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { valid } from "semver";

const sections = ["dependencies", "devDependencies", "optionalDependencies"];

function registryTarget(name, specifier) {
	if (specifier.startsWith("npm:")) {
		const separator = specifier.lastIndexOf("@");
		return { name: specifier.slice(4, separator), version: specifier.slice(separator + 1) };
	}
	return { name, version: specifier };
}

export function checkInstalledDependencies(root) {
	root = resolve(root);
	const manifestPath = join(root, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const lock = JSON.parse(readFileSync(join(root, "npm-shrinkwrap.json"), "utf8"));
	const failures = [];
	const require = createRequire(manifestPath);
	if (manifest.version !== lock.version || manifest.version !== lock.packages?.[""]?.version) {
		failures.push("Package and shrinkwrap root versions must match.");
	}
	for (const section of sections) {
		const declared = manifest[section] ?? {};
		const locked = lock.packages?.[""]?.[section] ?? {};
		for (const name of new Set([...Object.keys(declared), ...Object.keys(locked)])) {
			const specifier = declared[name];
			if (specifier !== locked[name]) {
				failures.push(`${section}.${name}: manifest ${specifier} differs from shrinkwrap ${locked[name]}.`);
			}
			if (typeof specifier !== "string") {
				failures.push(`${section}.${name}: expected a version string.`);
				continue;
			}
			const target = registryTarget(name, specifier);
			if (/^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:)/.test(specifier)) continue;
			if (valid(target.version) !== target.version) {
				failures.push(`${name}: expected an exact registry version, got ${specifier}.`);
				continue;
			}
			const entry = lock.packages?.[`node_modules/${name}`];
			if (entry?.version !== target.version) {
				failures.push(`${name}: shrinkwrap resolves ${entry?.version}, expected ${target.version}.`);
			}
			const candidates = (require.resolve.paths(name) ?? []).map((directory) =>
				join(directory, name, "package.json"),
			);
			const installedPath = candidates.find((candidate) => existsSync(candidate));
			if (!installedPath) {
				if (section !== "optionalDependencies") failures.push(`${name}: package is not installed.`);
				continue;
			}
			try {
				const installed = JSON.parse(readFileSync(installedPath, "utf8"));
				if (installed.name !== target.name || installed.version !== target.version) {
					failures.push(
						`${name}: installed ${installed.name}@${installed.version}, expected ${target.name}@${target.version} (${installedPath}).`,
					);
				}
			} catch (error) {
				failures.push(`${name}: cannot read installed package metadata: ${error.message}`);
			}
		}
	}
	return failures;
}

const modulePath = fileURLToPath(import.meta.url);
const mainPath = process.argv[1] && resolve(process.argv[1]);
if (
	mainPath &&
	(process.platform === "win32" ? mainPath.toLowerCase() === modulePath.toLowerCase() : mainPath === modulePath)
) {
	const failures = checkInstalledDependencies(resolve(import.meta.dirname, ".."));
	if (failures.length) {
		console.error(`Installed dependency checks failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
		console.error(
			"Reconcile package.json, npm-shrinkwrap.json, and node_modules before building or testing. See maintainers/dependencies.md.",
		);
		process.exitCode = 1;
	} else console.log("Verified declared, locked, and installed dependency versions.");
}
