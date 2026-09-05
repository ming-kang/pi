import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	loadRouterFile,
	parseRouterFile,
	removeRelay,
	saveRouterFile,
	upsertRelay,
} from "../src/extensions/router/store.ts";

describe("router config persistence", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("round trips additive settings and never rewrites on load", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-router-fields-"));
		roots.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		const file = parseRouterFile(
			JSON.stringify({
				version: 1,
				relays: [
					{
						id: "alpha",
						name: "Display",
						baseUrl: "https://relay.example",
						apiKey: "",
						catalog: "codex",
						headers: { "X-Relay": "$HEADER" },
						models: [
							{
								id: "m",
								reasoning: false,
								input: ["text"],
								contextWindow: 1000,
								maxTokens: 500,
								thinkingLevelMap: { off: "none", minimal: null, high: "custom" },
								headers: { "X-Model": "route" },
								cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0.5 },
								codex: { reasoningSummary: null, verbosity: "low", parallelToolCalls: false },
							},
						],
					},
				],
			}),
		);
		await saveRouterFile(file);
		const before = readFileSync(join(root, "router.json"), "utf8");
		expect(await loadRouterFile()).toEqual(file);
		expect(readFileSync(join(root, "router.json"), "utf8")).toBe(before);
	});

	it("validates nested settings and resolved token limits", () => {
		const parseModel = (model: object) =>
			parseRouterFile(
				JSON.stringify({
					relays: [{ id: "a", baseUrl: "https://relay.example", apiKey: "", models: [{ id: "m", ...model }] }],
				}),
			);
		for (const model of [
			{ contextWindow: Number.MAX_SAFE_INTEGER + 1 },
			{ contextWindow: 100, maxTokens: 101 },
			{ maxTokens: 300000 },
			{ codex: { extra: true } },
			{ codex: { reasoningSummary: "none" } },
			{ codex: { verbosity: true } },
			{ codex: { parallelToolCalls: null } },
			{ headers: { test: 1 } },
			{ cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } },
			{ cost: { input: 0 } },
		])
			expect(() => parseModel(model)).toThrow();
		expect(() => parseModel({ contextWindow: 100, maxTokens: 100, codex: { verbosity: null } })).not.toThrow();
		const legacy = parseModel({ contextWindow: 32768 }).relays[0].models[0];
		expect(legacy).toEqual({ id: "m", contextWindow: 32768 });
	});

	it("serializes whole read-modify-write mutations without lost relays", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-router-queue-"));
		roots.push(root);
		vi.stubEnv(ENV_AGENT_DIR, root);
		await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				upsertRelay({ id: `r${i}`, baseUrl: "https://relay.example", apiKey: "", models: [] }),
			),
		);
		expect((await loadRouterFile()).relays).toHaveLength(12);
		await Promise.all([
			removeRelay("r0"),
			upsertRelay({ id: "new", baseUrl: "https://relay.example", apiKey: "", models: [] }),
		]);
		const ids = (await loadRouterFile()).relays.map((relay) => relay.id);
		expect(ids).toHaveLength(12);
		expect(ids).not.toContain("r0");
		expect(ids).toContain("new");
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
