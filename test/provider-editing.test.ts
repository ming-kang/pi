import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProviderEdits } from "../src/extensions/provider/editing.ts";
import { RefreshCoordinator } from "../src/extensions/provider/refresh.ts";
import { DELETE, ModelsJsonStore } from "../src/extensions/provider/store.ts";

let directory: string;
let store: ModelsJsonStore;
let edits: ProviderEdits;
let refresher: RefreshCoordinator;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-provider-editing-"));
	const path = join(directory, "models.json");
	await writeFile(
		path,
		JSON.stringify({
			providers: {
				custom: { api: "openai-completions", baseUrl: "https://example.test/v1", models: [{ id: "old" }] },
			},
		}),
	);
	const loaded = await ModelsJsonStore.load(path);
	if (!loaded.ok) throw new Error(loaded.error);
	store = loaded.store;
	refresher = new RefreshCoordinator({
		refresh: async () => ({ aborted: false, errors: new Map() }),
		getError: () => undefined,
	});
	edits = new ProviderEdits(store, "custom", refresher, vi.fn());
});

afterEach(async () => {
	await store.flush();
	await rm(directory, { recursive: true, force: true });
});

test("nested draft edits are isolated until committed and preserve literal dictionary keys", async () => {
	const draft = edits.draft();
	const value = { $var: "thinking.effort" };
	draft.setField(["compat", "chatTemplateKwargs", "__proto__"], value);
	value.$var = "changed";
	draft.setField(["thinkingLevelMap", "high"], "high");
	draft.setField(["thinkingLevelMap", "high"], DELETE);
	draft.setField(["id"], "new");
	expect(store.getModel("custom", "new")).toBeUndefined();
	expect(refresher.touchedProviders).toEqual([]);
	expect(edits.commitDraft(draft)).toBeUndefined();
	await store.flush();
	const saved = JSON.parse(await readFile(store.path, "utf8")).providers.custom.models[1];
	expect(saved.compat.chatTemplateKwargs).toEqual(JSON.parse('{"__proto__":{"$var":"thinking.effort"}}'));
	expect(saved.thinkingLevelMap).toEqual({});
	expect(refresher.touchedProviders).toEqual(["custom"]);
});

test("a model handle follows a saved rename and subsequent edits target the new id", async () => {
	const renamed = vi.fn();
	const model = edits.model("old", renamed);
	expect(await model.rename("new")).toBeUndefined();
	expect(renamed).toHaveBeenCalledWith("old", "new");
	model.setField(["name"], "Renamed model");
	await store.flush();
	expect(store.getModel("custom", "old")).toBeUndefined();
	expect(store.getModel("custom", "new")?.name).toBe("Renamed model");
});

test("a failed rename keeps the handle on its original id and permits retry", async () => {
	const initial = await readFile(store.path, "utf8");
	const model = edits.model("old", vi.fn());
	await writeFile(store.path, "{ broken");
	expect(await model.rename("new")).toBeDefined();
	expect(model.read().id).toBe("old");
	expect(edits.renaming).toBe(false);
	await writeFile(store.path, initial);
	expect(await model.rename("new")).toBeUndefined();
	expect(model.read().id).toBe("new");
});

test("batch edits and provider deletion both participate in runtime refresh", async () => {
	const model = edits.model("old", vi.fn());
	edits.batch(() => {
		model.setField(["name"], "Updated");
		edits.setProviderField(["apiKey"], "$FIXTURE_KEY");
	});
	await store.flush();
	expect(refresher.touchedProviders).toEqual(["custom"]);
	await refresher.flush();
	edits.removeProvider();
	await store.flush();
	expect(store.getProvider("custom")).toBeUndefined();
	expect(refresher.touchedProviders).toEqual(["custom"]);
});
