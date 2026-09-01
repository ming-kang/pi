import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { parseRouterFile, upsertRelay } from "../src/extensions/router/store.ts";

describe("router config persistence", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("accepts versionless legacy v1 files and rejects future versions", () => {
		expect(
			parseRouterFile(
				JSON.stringify({
					relays: [{ id: "alpha", baseUrl: "https://relay.example/v1", apiKey: "secret", models: [] }],
				}),
			),
		).toEqual({
			version: 1,
			relays: [{ id: "alpha", baseUrl: "https://relay.example/v1", apiKey: "secret", models: [] }],
		});
		expect(() => parseRouterFile(JSON.stringify({ version: 2, relays: [] }))).toThrow(/unsupported version 2/);
	});

	it("reports strict path-specific relay and model errors", () => {
		const cases: Array<[unknown, string]> = [
			[
				{ version: 1, relays: [{ id: "bad/id", baseUrl: "https://relay.example", apiKey: "", models: [] }] },
				"relays[0].id",
			],
			[
				{ version: 1, relays: [{ id: "alpha", baseUrl: "ftp://relay.example", apiKey: "", models: [] }] },
				"relays[0].baseUrl",
			],
			[
				{ version: 1, relays: [{ id: "alpha", baseUrl: "https://relay.example", apiKey: 1, models: [] }] },
				"relays[0].apiKey",
			],
			[
				{
					version: 1,
					relays: [
						{
							id: "alpha",
							baseUrl: "https://relay.example",
							apiKey: "",
							models: [{ id: "model", input: ["image"] }],
						},
					],
				},
				"relays[0].models[0].input",
			],
			[
				{
					version: 1,
					relays: [
						{
							id: "alpha",
							baseUrl: "https://relay.example",
							apiKey: "",
							models: [{ id: "model", thinkingLevelMap: { turbo: "high" } }],
						},
					],
				},
				"thinkingLevelMap",
			],
		];
		for (const [value, path] of cases) {
			expect(() => parseRouterFile(JSON.stringify(value))).toThrow(path);
		}
	});

	it("rejects duplicate ids and unknown fields instead of silently dropping data", () => {
		expect(() =>
			parseRouterFile(
				JSON.stringify({
					version: 1,
					relays: [
						{ id: "alpha", baseUrl: "https://relay.example", apiKey: "", models: [] },
						{ id: "alpha", baseUrl: "https://other.example", apiKey: "", models: [] },
					],
				}),
			),
		).toThrow(/duplicate relay id/);
		expect(() =>
			parseRouterFile(
				JSON.stringify({
					version: 1,
					relays: [{ id: "alpha", baseUrl: "https://relay.example", apiKey: "", models: [], extra: true }],
				}),
			),
		).toThrow(/relays\[0\].*unsupported field/);
	});

	it("stops mutations and leaves malformed bytes unchanged", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-router-invalid-"));
		roots.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		const filePath = join(root, "router.json");
		const invalid = `${JSON.stringify({
			version: 1,
			relays: [
				{ id: "alpha", baseUrl: "https://relay.example", apiKey: "secret", models: [{ name: "missing id" }] },
			],
		})}\n`;
		writeFileSync(filePath, invalid);

		await expect(
			upsertRelay({ id: "beta", baseUrl: "https://beta.example", apiKey: "secret", models: [] }),
		).rejects.toThrow(/relays\[0\].models\[0\].id/);
		expect(readFileSync(filePath, "utf8")).toBe(invalid);
	});
});
