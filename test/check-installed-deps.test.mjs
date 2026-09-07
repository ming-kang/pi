import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkInstalledDependencies } from "../scripts/check-installed-deps.mjs";

const directories = [];
function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-installed-deps-"));
	directories.push(root);
	const manifest = {
		name: "fixture", version: "1.0.0",
		dependencies: { example: "2.0.0" },
		devDependencies: { alias: "npm:dev-example@3.0.0" },
		optionalDependencies: { optional: "4.0.0" },
	};
	const lock = {
		version: "1.0.0",
		packages: {
			"": manifest,
			"node_modules/example": { version: "2.0.0" },
			"node_modules/alias": { name: "dev-example", version: "3.0.0" },
			"node_modules/optional": { version: "4.0.0" },
		},
	};
	writeJson(join(root, "package.json"), manifest);
	writeJson(join(root, "npm-shrinkwrap.json"), lock);
	writeJson(join(root, "node_modules/example/package.json"), {
		name: "example", version: "2.0.0", exports: { "./feature": "./feature.js" },
	});
	writeJson(join(root, "node_modules/alias/package.json"), { name: "dev-example", version: "3.0.0" });
	return { root, manifest, lock };
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("installed dependency gate", () => {
	test("accepts exports-restricted metadata, npm aliases, and absent optional packages", () => {
		expect(checkInstalledDependencies(fixture().root)).toEqual([]);
	});
	test("rejects old package files even when npm's hidden cache claims the new version", () => {
		const { root, lock } = fixture();
		writeJson(join(root, "node_modules/.package-lock.json"), lock);
		writeJson(join(root, "node_modules/example/package.json"), { name: "example", version: "1.0.0" });
		expect(checkInstalledDependencies(root).join("\n")).toContain("installed example@1.0.0, expected example@2.0.0");
	});
	test("rejects a moved dependency whose lockfile still has the old scope", () => {
		const { root, manifest } = fixture();
		manifest.devDependencies.example = manifest.dependencies.example;
		delete manifest.dependencies.example;
		writeJson(join(root, "package.json"), manifest);
		const failures = checkInstalledDependencies(root).join("\n");
		expect(failures).toContain("dependencies.example");
		expect(failures).toContain("devDependencies.example");
	});
	test("rejects missing required packages and a mismatched locked resolution", () => {
		const { root, lock } = fixture();
		rmSync(join(root, "node_modules/alias"), { recursive: true });
		lock.packages["node_modules/example"].version = "1.9.0";
		writeJson(join(root, "npm-shrinkwrap.json"), lock);
		const failures = checkInstalledDependencies(root).join("\n");
		expect(failures).toContain("alias: package is not installed");
		expect(failures).toContain("shrinkwrap resolves 1.9.0, expected 2.0.0");
	});
});
