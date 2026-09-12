import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { compatFieldsForApi } from "../src/extensions/provider/compat-fields.ts";
import { RefreshCoordinator } from "../src/extensions/provider/refresh.ts";
import { ModelsJsonStore } from "../src/extensions/provider/store.ts";
import { createProviderApp, createProviderErrorScreen } from "../src/extensions/provider/ui/app.ts";
import { BuiltinPreviewPane } from "../src/extensions/provider/ui/builtin-data.ts";
import { CompatKeyPickerPane, CompatPane } from "../src/extensions/provider/ui/compat.ts";
import { ProviderEditorScreen } from "../src/extensions/provider/ui/editor.ts";
import { FetchModelsPane } from "../src/extensions/provider/ui/fetch-models.ts";
import { CostPane } from "../src/extensions/provider/ui/model-options.ts";
import type { EditorHost, ModelHandle } from "../src/extensions/provider/ui/pane.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

let directory: string;
let store: ModelsJsonStore;
let tui: TUI;
let keys: KeybindingsManager;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "pi-provider-ui-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	initTheme("dark");
	keys = new KeybindingsManager();
	setKeybindings(keys);
	const path = join(directory, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				cpa: {
					baseUrl: "https://old.example/v1",
					api: "openai-completions",
					models: [{ id: "k3" }],
				},
			},
		}),
	);
	const loaded = await ModelsJsonStore.load(path);
	if (!loaded.ok) throw new Error(loaded.error);
	store = loaded.store;
	tui = new TuiMainScreen(new VirtualTerminal(120, 40));
	vi.spyOn(tui, "requestRender").mockImplementation(() => {});
});

afterEach(async () => {
	await store.flush();
	tui?.stop();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function runtimeStub() {
	return {
		refresh: vi.fn(async () => ({ aborted: false, errors: new Map<string, Error>() })),
		getError: () => undefined,
		getAuth: async () => undefined,
		getProviderAuthStatus: () => ({ configured: false }),
	};
}

function editor() {
	const runtime = runtimeStub();
	const done = vi.fn();
	const screen = new ProviderEditorScreen(tui, theme, keys, done, {
		store,
		providerId: "cpa",
		runtime,
		registry: runtime,
		refresher: new RefreshCoordinator(runtime),
		notify: vi.fn(),
	});
	screen.focused = true;
	return { screen, done };
}

function hostFixture(): { host: EditorHost; model: ModelHandle } {
	const host: EditorHost = {
		tui,
		theme,
		keybindings: keys,
		store,
		providerId: "cpa",
		refresher: new RefreshCoordinator(runtimeStub()),
		pushPane: vi.fn(),
		popPane: vi.fn(),
		mutate: (apply) => apply(),
		refresh: vi.fn(),
		notify: vi.fn(),
		effectiveApi: () => "openai-completions",
		effectiveBaseUrl: () => "https://old.example/v1",
		commitModelDraft: () => undefined,
		isCurrentModel: () => false,
		isCurrentProvider: () => false,
		setFetchStatus: vi.fn(),
		runFetch: async () => ({ ok: true, models: [{ id: "new-model" }], truncated: false }),
		importModels: async () => undefined,
		confirm: vi.fn(),
		onModelRemoved: vi.fn(),
	};
	const model: ModelHandle = {
		isDraft: false,
		read: () => store.getModel("cpa", "k3") ?? {},
		setField: (path, value) => store.setModelField("cpa", "k3", path, value),
		rename: (newId) => store.renameModel("cpa", "k3", newId),
	};
	return { host, model };
}

function render(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(120).join("\n"));
}

function appFixture() {
	const runtime = runtimeStub();
	const done = vi.fn();
	const setModel = vi.fn(async (_model: Model<Api>) => true);
	const app = createProviderApp(tui, theme, keys, done, {
		store,
		runtime,
		registry: {
			...runtime,
			find: () => ({
				id: "k3",
				name: "k3",
				provider: "cpa",
				api: "openai-completions",
				baseUrl: "https://old.example/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: store.getModel("cpa", "k3")?.contextWindow ?? 128000,
				maxTokens: 16384,
			}),
		},
		getCurrentModel: () => ({ provider: "cpa", id: "k3" }),
		setModel,
		notify: vi.fn(),
		initialProviderId: "cpa",
	});
	return { app, done, setModel, runtime };
}

describe("provider modal lifecycle", () => {
	test("a corrupt-config error screen closes with the configured cancel key", () => {
		const done = vi.fn();
		const screen = createProviderErrorScreen(tui, done, "Invalid JSON");
		screen.handleInput("\x1b");
		expect(done).toHaveBeenCalledOnce();
	});

	test("closing after Fetch still updates the active model metadata", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ data: [] }))),
		);
		const { app, done, setModel } = appFixture();
		for (let index = 0; index < 3; index++) app.handleInput("\x1b[B");
		app.handleInput("\x1b[C");
		for (let index = 0; index < 6; index++) app.handleInput("\x1b[B");
		app.handleInput("262144");
		app.handleInput("\r");
		await store.flush();
		app.handleInput("\x1b[D");
		app.handleInput("\x1b[A");
		app.handleInput("\x1b[C");
		await vi.waitFor(() => expect(render(app)).toContain("No matching models"));
		app.handleInput("\x1b");
		app.handleInput("\x1b");
		app.handleInput("\x1b");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 262144 }));
		app.dispose();
	});

	test("a failed save stays available for retry when the modal closes", async () => {
		const initial = readFileSync(store.path, "utf8");
		const { app, done } = appFixture();
		writeFileSync(store.path, "{ broken JSON");
		app.handleInput("\x1b[C");
		app.handleInput("https://new.example/v1");
		app.handleInput("\r");
		await store.flush();
		app.handleInput("\x1b");
		app.handleInput("\x1b");
		app.handleInput("\x1b");
		await vi.waitFor(() => expect(render(app)).toContain("Some changes are not saved"));
		expect(done).not.toHaveBeenCalled();
		writeFileSync(store.path, initial);
		app.handleInput("\x1b[B");
		app.handleInput("\r");
		await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
		expect(JSON.parse(readFileSync(store.path, "utf8")).providers.cpa.baseUrl).toBe("https://new.example/v1");
		app.dispose();
	});
});

describe("provider editor interactions", () => {
	test("cost edits preserve other rates, price tiers, and unknown fields", async () => {
		const cost = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			future: "keep",
			tiers: [{ inputTokensAbove: 1000, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }],
		};
		store.setModelField("cpa", "k3", ["cost"], cost);
		await store.flush();
		const { host, model } = hostFixture();
		const pane = new CostPane(host, model);
		pane.handleInput("9");
		pane.handleInput("\r");
		await store.flush();
		expect(store.getModel("cpa", "k3")?.cost).toEqual({ ...cost, input: 9 });
	});

	test("a provider API change invalidates an open built-in preview", () => {
		const { host, model } = hostFixture();
		const reference: Model<"openai-completions"> = {
			id: "reference",
			name: "Reference",
			provider: "reference",
			api: "openai-completions",
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1000,
		};
		const pane = new BuiltinPreviewPane(host, model, { providerId: "reference", model: reference });
		host.effectiveApi = () => "anthropic-messages";
		pane.handleInput("\x1b[A");
		pane.handleInput("\r");
		expect(render(pane)).toContain("API changed");
		expect(store.pendingCount).toBe(0);
	});

	test("Delete Provider gives the confirmation keyboard focus", async () => {
		const { screen, done } = editor();
		screen.handleInput("\x1b[A");
		screen.handleInput("\r");
		expect(render(screen)).toContain("Delete provider");
		screen.handleInput("\x1b[A");
		screen.handleInput("\r");
		await store.flush();
		expect(done).toHaveBeenCalledWith("deleted");
		expect(store.getProvider("cpa")).toBeUndefined();
		screen.dispose();
	});

	test("pasting on a value row overwrites it and keeps the fixed key prefix", async () => {
		const { screen } = editor();
		screen.handleInput("\x1b[C");
		screen.handleInput("\x1b[200~https://new.example/v1\x1b[201~");
		expect(render(screen)).toContain("baseUrl: https://new.example/v1");
		expect(render(screen)).not.toContain("baseUrl: >");
		screen.handleInput("\r");
		await store.flush();
		const doc = JSON.parse(readFileSync(store.path, "utf8"));
		expect(doc.providers.cpa.baseUrl).toBe("https://new.example/v1");
		screen.dispose();
	});

	test("cannot unset the API while a custom model inherits it", async () => {
		const { screen } = editor();
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[C");
		screen.handleInput("\x1b[A");
		screen.handleInput("\x1b[A");
		screen.handleInput("\r");
		await store.flush();
		expect(store.getProvider("cpa")?.api).toBe("openai-completions");
		expect(render(screen)).toContain("rely");
		screen.dispose();
	});

	test("new compat fields display their value choice before writing", () => {
		const { host, model } = hostFixture();
		const pane = new CompatPane(host, model);
		pane.setFocused(true);
		pane.handleInput("\r");
		const picker = vi.mocked(host.pushPane).mock.calls[0]![0];
		picker.handleInput("\r");
		expect(render(pane)).toContain("supportsStore:");
		expect(render(pane)).toContain("false");
		expect(store.getModel("cpa", "k3")?.compat).toBeUndefined();
		pane.handleInput("\x1b[B");
		pane.handleInput("\r");
		expect(store.getModel("cpa", "k3")?.compat).toMatchObject({ supportsStore: false });
	});

	test("the compat key picker scrolls with its selection", () => {
		const { host } = hostFixture();
		const picker = new CompatKeyPickerPane(host, "openai-completions", new Set(), vi.fn());
		picker.setFocused(true);
		for (let index = 0; index < 14; index++) picker.handleInput("\x1b[B");
		const selected = compatFieldsForApi("openai-completions")[14]!;
		expect(render(picker)).toContain(`› ${selected.key}`);
	});

	test("finishing an import after leaving its pane cannot pop another page", async () => {
		const { host } = hostFixture();
		let finish!: () => void;
		host.importModels = async () =>
			new Promise<undefined>((resolve) => {
				finish = () => resolve(undefined);
			});
		const pane = new FetchModelsPane(host);
		pane.setFocused(true);
		pane.start();
		await vi.waitFor(() => expect(render(pane)).toContain("new-model"));
		pane.handleInput(" ");
		pane.handleInput("\r");
		pane.handleInput("\x1b");
		pane.dispose();
		expect(host.popPane).toHaveBeenCalledTimes(1);
		finish();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(host.popPane).toHaveBeenCalledTimes(1);
	});
});

describe("provider refresh coordination", () => {
	test("a fetch refresh retains the changed-provider ledger for the live model", async () => {
		const runtime = runtimeStub();
		const coordinator = new RefreshCoordinator(runtime);
		coordinator.touch("cpa");
		await coordinator.refreshNow("cpa");
		expect(coordinator.touchedProviders).toEqual(["cpa"]);
		await coordinator.flush();
		expect(runtime.refresh).toHaveBeenCalledTimes(1);
	});

	test("an aborted refresh remains pending for the next close", async () => {
		const runtime = runtimeStub();
		runtime.refresh.mockResolvedValueOnce({ aborted: true, errors: new Map() });
		const coordinator = new RefreshCoordinator(runtime);
		coordinator.touch("cpa");
		expect((await coordinator.refreshNow("cpa")).ok).toBe(false);
		await coordinator.flush();
		expect(runtime.refresh).toHaveBeenCalledTimes(2);
	});
});
