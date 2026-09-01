import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	createSourceEnvironment,
	credentialVariables,
	parseSourceArguments,
} from "../scripts/run-source.mjs";

const root = join(import.meta.dirname, "..");

function documentedProviderVariables() {
	const providers = readFileSync(join(root, "docs", "providers.md"), "utf8");
	const table = providers.split("| Provider | Environment Variable |", 2)[1]?.split("See [Environment variables]", 1)[0] ?? "";
	const variables = new Set([...table.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1]));
	for (const match of providers.matchAll(/export\s+([A-Z][A-Z0-9_]+)=/g)) variables.add(match[1]);
	for (const path of [
		join(root, "docs", "llama-cpp.md"),
		join(root, "docs", "bundled", "extensions", "web-search.md"),
	]) {
		const contents = readFileSync(path, "utf8");
		for (const match of contents.matchAll(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|BASE_URL))\b/g)) {
			variables.add(match[1]);
		}
	}
	return [...variables].filter(Boolean).sort();
}

describe("run-source --no-env", () => {
	test("covers every documented provider credential and cloud variable", () => {
		const configured = new Set(credentialVariables);
		const missing = documentedProviderVariables().filter((name) => !configured.has(name));
		expect(missing).toEqual([]);
	});

	test("removes credential variables without mutating the source environment", () => {
		const source = { ANTHROPIC_API_KEY: "secret", GOOGLE_CLOUD_PROJECT: "project", PATH: "tools" };
		const isolated = createSourceEnvironment(source, true);
		expect(isolated).toEqual({ PATH: "tools" });
		expect(source).toHaveProperty("ANTHROPIC_API_KEY", "secret");
		expect(createSourceEnvironment(source, false)).toEqual(source);
	});

	test("consumes --no-env and forwards all other arguments in order", () => {
		expect(parseSourceArguments(["--provider", "anthropic", "--no-env", "--model", "test"])).toEqual({
			forwardedArguments: ["--provider", "anthropic", "--model", "test"],
			withoutCredentials: true,
		});
	});
});
