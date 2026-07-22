#!/usr/bin/env node

import { readFileSync } from "node:fs";

function readPackageJson(relativePath) {
	return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}

const codingAgentPackage = readPackageJson("packages/coding-agent/package.json");
const serverPackage = readPackageJson("packages/server/package.json");
const failures = [];

if (codingAgentPackage.name !== "@astralyn/pi") {
	failures.push(`packages/coding-agent/package.json name must be @astralyn/pi, found ${codingAgentPackage.name}`);
}

const serverVersion = serverPackage.dependencies?.["@astralyn/pi"];
if (serverVersion === undefined) {
	failures.push("packages/server/package.json must depend on @astralyn/pi");
} else if (serverVersion !== codingAgentPackage.version) {
	failures.push(
		`packages/server/package.json depends on @astralyn/pi@${serverVersion}, expected ${codingAgentPackage.version}`,
	);
}

if (failures.length > 0) {
	console.error("Fork package metadata is inconsistent:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

console.log(`Fork package versions are consistent (${codingAgentPackage.name}@${codingAgentPackage.version}).`);
