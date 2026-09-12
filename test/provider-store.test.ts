import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { DELETE, ModelsJsonStore, type SaveResult } from "../src/extensions/provider/store.ts";

let tempDir: string;
let modelsPath: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-test-provider-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	modelsPath = join(tempDir, "models.json");
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});

function writeDisk(doc: unknown): void {
	writeFileSync(modelsPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

interface DiskProvider {
	models: Record<string, unknown>[];
	[key: string]: unknown;
}

function readDisk(): { providers: Record<string, DiskProvider> } {
	return JSON.parse(readFileSync(modelsPath, "utf8"));
}

async function loadStore(doc?: unknown): Promise<ModelsJsonStore> {
	if (doc !== undefined) writeDisk(doc);
	const load = await ModelsJsonStore.load(modelsPath);
	if (!load.ok) throw new Error(`load failed: ${load.error}`);
	return load.store;
}

async function flush(store: ModelsJsonStore): Promise<SaveResult[]> {
	const results: SaveResult[] = [];
	store.onSaveResult = (result) => results.push(result);
	await store.flush();
	return results;
}

describe("provider store", () => {
	test("retains edits confirmed while a previous candidate is being validated", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://old.example" } } });
		let entered!: () => void;
		let release!: () => void;
		const validating = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalLoad = ModelConfig.load.bind(ModelConfig);
		let blocked = false;
		vi.spyOn(ModelConfig, "load").mockImplementation(async (path) => {
			if (path?.endsWith(".tmp") && !blocked) {
				blocked = true;
				entered();
				await gate;
			}
			return originalLoad(path);
		});
		store.setProviderField("cpa", ["baseUrl"], "https://new.example");
		await validating;
		store.setProviderField("cpa", ["apiKey"], "review-fixture-key");
		release();
		await store.flush();
		expect(readDisk().providers.cpa).toMatchObject({ baseUrl: "https://new.example", apiKey: "review-fixture-key" });
		expect(store.pendingCount).toBe(0);
	});

	test("holds a colliding model import until the user resolves it", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a", models: [] } } });
		const external = { id: "k3", name: "External model", contextWindow: 262144 };
		writeDisk({ providers: { cpa: { baseUrl: "https://a", models: [external] } } });
		store.addModel("cpa", { id: "k3", name: "Imported model" });
		const first = (await flush(store)).at(-1);
		expect(first?.kind).toBe("conflict");
		store.setProviderField("cpa", ["baseUrl"], "https://b");
		const later = (await flush(store)).at(-1);
		expect(readDisk().providers.cpa.models).toEqual([external]);
		expect(later?.kind).toBe("conflict");
		expect(store.pendingCount).toBe(1);
	});

	test("a provider draft never mutates the disk baseline", async () => {
		const store = await loadStore({ providers: {} });
		store.ensureProviderView("scratch");
		expect(store.isDraftProvider("scratch")).toBe(true);
		store.discardProviderDraft("scratch");
		expect(store.getProvider("scratch")).toBeUndefined();
		expect(readDisk().providers).toEqual({});
	});

	test("an incomplete provider stays in memory until its connection is configured", async () => {
		const store = await loadStore({ providers: {} });
		store.ensureProviderView("draft");
		store.setProviderField("draft", ["api"], "openai-completions");
		await store.flush();
		expect(readDisk().providers).toEqual({});
		store.setProviderField("draft", ["baseUrl"], "https://example.test/v1");
		await store.flush();
		expect(readDisk().providers.draft).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
		});
	});

	test("a rename conflict cannot adopt an unrelated model at the destination id", async () => {
		const store = await loadStore({
			providers: { cpa: { baseUrl: "https://a", models: [{ id: "old", name: "Mine" }] } },
		});
		writeDisk({ providers: { cpa: { baseUrl: "https://a", models: [{ id: "new", name: "External" }] } } });
		expect(await store.renameModel("cpa", "old", "new")).toBeDefined();
		expect(readDisk().providers.cpa.models).toEqual([{ id: "new", name: "External" }]);
		expect(store.pendingCount).toBe(0);
	});

	test("conflict previews mask API keys while retaining the raw value for resolution", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a", apiKey: "initial-fixture" } } });
		writeDisk({ providers: { cpa: { baseUrl: "https://a", apiKey: "external-fixture-secret" } } });
		store.setProviderField("cpa", ["apiKey"], "local-fixture-secret");
		const result = (await flush(store)).at(-1);
		if (result?.kind !== "conflict") throw new Error("Expected conflict");
		expect(result.conflicts[0].external).not.toContain("external-fixture-secret");
		expect(result.conflicts[0].attempted).not.toContain("local-fixture-secret");
		expect(result.conflicts[0].externalRaw).toBe("external-fixture-secret");
	});

	test("creates the models directory before acquiring its first file lock", async () => {
		modelsPath = join(tempDir, "nested", "agent", "models.json");
		const store = await loadStore();
		store.setProviderField("cpa", ["baseUrl"], "https://a");
		expect((await flush(store)).at(-1)?.kind).toBe("saved");
		expect(readDisk().providers.cpa.baseUrl).toBe("https://a");
	});

	test("creates a missing file on first save and backs up only existing files", async () => {
		const store = await loadStore();
		store.setProviderField("cpa", ["baseUrl"], "https://api.cpa.example");
		const results = await flush(store);
		expect(results.at(-1)).toMatchObject({ kind: "saved" });
		expect(readDisk().providers.cpa.baseUrl).toBe("https://api.cpa.example");
		// No .bak without a pre-existing file.
		expect(existsSync(`${modelsPath}.bak`)).toBe(false);

		store.setProviderField("cpa", ["apiKey"], "sk-1");
		await flush(store);
		// First write to an existing file creates the backup with the previous content.
		expect(existsSync(`${modelsPath}.bak`)).toBe(true);
		expect(JSON.parse(readFileSync(`${modelsPath}.bak`, "utf8")).providers.cpa.apiKey).toBeUndefined();
	});

	test("preserves unknown fields while normalizing comments and formatting", async () => {
		writeFileSync(
			modelsPath,
			`{
  // a comment
  "customTopLevel": { "keep": true },
  "providers": { "cpa": { "baseUrl": "https://a", "customProviderField": 42, "models": [] } }
}`,
			"utf8",
		);
		const store = await loadStore();
		store.setProviderField("cpa", ["api"], "openai-completions");
		await flush(store);
		const disk = readDisk() as Record<string, unknown>;
		expect(disk.customTopLevel).toEqual({ keep: true });
		expect((disk.providers as Record<string, Record<string, unknown>>).cpa.customProviderField).toBe(42);
		// Comments are gone after the rewrite.
		expect(readFileSync(modelsPath, "utf8")).not.toContain("// a comment");
	});

	test("adds, edits, renames, and removes models", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a" } } });
		store.addModel("cpa", { id: "k3", name: "Kimi K3" });
		await flush(store);
		expect(readDisk().providers.cpa.models).toEqual([{ id: "k3", name: "Kimi K3" }]);

		store.setModelField("cpa", "k3", ["contextWindow"], 262144);
		await flush(store);
		expect(readDisk().providers.cpa.models[0].contextWindow).toBe(262144);

		await store.renameModel("cpa", "k3", "k3.1");
		await flush(store);
		expect(readDisk().providers.cpa.models[0].id).toBe("k3.1");
		expect(readDisk().providers.cpa.models[0].name).toBe("Kimi K3");

		store.removeModel("cpa", "k3.1");
		await flush(store);
		expect(readDisk().providers.cpa.models).toEqual([]);
	});

	test("DELETE removes a key; empty self-cancelled draft providers are pruned", async () => {
		const store = await loadStore();
		store.ensureProviderView("draft");
		store.setProviderField("draft", ["baseUrl"], "https://x");
		store.setProviderField("draft", ["baseUrl"], DELETE);
		await flush(store);
		// Nothing net to write: no file created at all.
		expect(existsSync(modelsPath)).toBe(false);
	});

	test("merges unrelated external edits and conflicts only the moved field", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a", api: "openai-completions" } } });
		store.setProviderField("cpa", ["baseUrl"], "https://b");
		await flush(store);

		// External editor changes apiKey (unrelated) and api (conflicting).
		writeDisk({ providers: { cpa: { baseUrl: "https://b", api: "openai-responses", apiKey: "sk-ext" } } });

		store.setProviderField("cpa", ["api"], "anthropic-messages"); // base "openai-completions" vs disk "openai-responses"
		store.setProviderField("cpa", ["headers"], { "x-trace": "1" }); // untouched externally
		const results = await flush(store);
		const last = results.at(-1);
		expect(last?.kind).toBe("conflict");
		if (last?.kind !== "conflict") throw new Error("expected conflict");
		expect(last.conflicts).toHaveLength(1);
		expect(last.conflicts[0].location).toContain("cpa");
		expect(last.conflicts[0].location).toContain("api");

		// Unrelated external change and our other op were merged and written.
		const disk = readDisk().providers.cpa;
		expect(disk.apiKey).toBe("sk-ext");
		expect(disk.headers).toEqual({ "x-trace": "1" });
		expect(disk.api).toBe("openai-responses"); // external value kept
		// View still shows the user's attempted value (op held).
		expect(store.getProvider("cpa")?.api).toBe("anthropic-messages");

		// Keep mine: rebase and overwrite the external value.
		store.resolveConflict(last.conflicts[0].op.seq, "keep", last.conflicts[0].externalRaw, true);
		await flush(store);
		expect(readDisk().providers.cpa.api).toBe("anthropic-messages");
	});

	test("use-external conflict resolution drops the op", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a" } } });
		writeDisk({ providers: { cpa: { baseUrl: "https://external" } } });
		store.setProviderField("cpa", ["baseUrl"], "https://mine");
		const results = await flush(store);
		const last = results.at(-1);
		expect(last?.kind).toBe("conflict");
		if (last?.kind !== "conflict") throw new Error("expected conflict");
		store.resolveConflict(last.conflicts[0].op.seq, "external", undefined, false);
		await flush(store);
		expect(readDisk().providers.cpa.baseUrl).toBe("https://external");
		expect(store.getProvider("cpa")?.baseUrl).toBe("https://external");
	});

	test("rejects schema-invalid candidates without touching the file", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a" } } });
		store.addModel("cpa", { id: "k3" });
		await flush(store);
		const before = readFileSync(modelsPath, "utf8");
		store.setModelField("cpa", "k3", ["contextWindow"], "not-a-number");
		const results = await flush(store);
		expect(results.at(-1)?.kind).toBe("invalid");
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		// The invalid op is dropped from the view? No: it stays pending — but the file is intact.
		expect(store.getModel("cpa", "k3")?.contextWindow).toBe("not-a-number");
	});

	test("refuses to save over a file that became unreadable", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a" } } });
		writeFileSync(modelsPath, "{ not json", "utf8");
		store.setProviderField("cpa", ["baseUrl"], "https://b");
		const results = await flush(store);
		expect(results.at(-1)?.kind).toBe("error");
		expect(readFileSync(modelsPath, "utf8")).toBe("{ not json");
	});

	test("no write and no backup when nothing changed", async () => {
		writeDisk({ providers: { cpa: { baseUrl: "https://a" } } });
		const store = await loadStore();
		const before = readFileSync(modelsPath, "utf8");
		await flush(store);
		expect(readFileSync(modelsPath, "utf8")).toBe(before);
		expect(existsSync(`${modelsPath}.bak`)).toBe(false);
	});

	test("removeProvider deletes the whole record; discardProviderDraft rolls back unsaved drafts", async () => {
		const store = await loadStore({ providers: { cpa: { baseUrl: "https://a" }, other: { baseUrl: "https://b" } } });
		store.removeProvider("cpa");
		await flush(store);
		expect(Object.keys(readDisk().providers)).toEqual(["other"]);

		store.ensureProviderView("scratch");
		store.setProviderField("scratch", ["baseUrl"], "https://scratch");
		store.discardProviderDraft("scratch");
		expect(store.getProvider("scratch")).toBeUndefined();
	});

	test("reports schema-invalid existing files as a read-only load error", async () => {
		writeFileSync(modelsPath, JSON.stringify({ providers: "nope" }), "utf8");
		const load = await ModelsJsonStore.load(modelsPath);
		expect(load.ok).toBe(false);
	});
});
