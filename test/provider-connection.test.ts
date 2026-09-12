import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchProviderModels, importProviderModels } from "../src/extensions/provider/connection.ts";
import { RefreshCoordinator } from "../src/extensions/provider/refresh.ts";
import { ModelsJsonStore } from "../src/extensions/provider/store.ts";

let directory: string;
let store: ModelsJsonStore;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "pi-provider-connection-"));
	const path = join(directory, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				cpa: {
					baseUrl: "https://example.test/v1",
					api: "openai-completions",
					apiKey: "fixture-key",
					models: [],
				},
			},
		}),
	);
	const loaded = await ModelsJsonStore.load(path);
	if (!loaded.ok) throw new Error(loaded.error);
	store = loaded.store;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ data: [] }))),
	);
});

afterEach(async () => {
	await store.flush();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const runtime = {
		refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
		getError: () => undefined,
		getAuth: vi.fn(async (): Promise<AuthResult | undefined> => ({ auth: { apiKey: "fixture-key" } })),
		getProviderAuthStatus: () => ({ configured: true }),
	};
	return { runtime, options: { store, runtime, providerId: "cpa", refresher: new RefreshCoordinator(runtime) } };
}

describe("provider connection operations", () => {
	test("a failed save cannot send old credentials to a newly edited URL", async () => {
		const { runtime, options } = fixture();
		writeFileSync(store.path, "{ broken JSON");
		store.setProviderField("cpa", ["baseUrl"], "https://different.example/v1");
		const result = await fetchProviderModels(options, new AbortController().signal);
		expect(result.ok).toBe(false);
		expect(runtime.getAuth).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(store.pendingCount).toBe(1);
	});

	test("resolved header authentication overrides a configured fallback key", async () => {
		const { runtime, options } = fixture();
		runtime.getAuth.mockResolvedValue({ auth: { headers: { Authorization: "Bearer resolved-header" } } });
		expect((await fetchProviderModels(options, new AbortController().signal)).ok).toBe(true);
		const init = vi.mocked(globalThis.fetch).mock.calls[0]![1]!;
		expect(new Headers(init.headers).get("authorization")).toBe("Bearer resolved-header");
	});

	test("configured credentials cannot silently fall back to anonymous discovery", async () => {
		const { runtime, options } = fixture();
		runtime.getAuth.mockResolvedValue(undefined);
		expect((await fetchProviderModels(options, new AbortController().signal)).ok).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	test("cancelling credential resolution stops waiting and sends no HTTP request", async () => {
		const { runtime, options } = fixture();
		runtime.getAuth.mockImplementation(() => new Promise(() => {}));
		const controller = new AbortController();
		const pending = fetchProviderModels(options, controller.signal);
		await vi.waitFor(() => expect(runtime.getAuth).toHaveBeenCalledOnce());
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: "Cancelled." });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	test("an import that fails to save does not refresh or report success", async () => {
		const { runtime, options } = fixture();
		writeFileSync(store.path, "{ broken JSON");
		expect(await importProviderModels(options, [{ id: "new-model" }], new AbortController().signal)).toBeDefined();
		expect(runtime.refresh).not.toHaveBeenCalled();
	});
});
