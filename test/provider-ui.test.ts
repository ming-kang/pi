import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { compatFieldsForApi } from "../src/extensions/provider/compat-fields.ts";
import { RefreshCoordinator } from "../src/extensions/provider/refresh.ts";
import { DELETE, ModelsJsonStore } from "../src/extensions/provider/store.ts";
import { createProviderApp, createProviderErrorScreen } from "../src/extensions/provider/ui/app.ts";
import { BuiltinPreviewPane } from "../src/extensions/provider/ui/builtin-data.ts";
import { CompatKeyPickerPane, CompatPane } from "../src/extensions/provider/ui/compat.ts";
import { ProviderEditorScreen } from "../src/extensions/provider/ui/editor.ts";
import { FetchModelsPane } from "../src/extensions/provider/ui/fetch-models.ts";
import { CostPane, ModelApiTypePane, ModelSpecificApiPane } from "../src/extensions/provider/ui/model-options.ts";
import type { EditorHost, ModelHandle } from "../src/extensions/provider/ui/pane.ts";
import { ApiTypePane } from "../src/extensions/provider/ui/provider-fields.ts";
import { ProviderListScreen } from "../src/extensions/provider/ui/provider-list.ts";
import { windowLines } from "../src/extensions/provider/ui/value-row.ts";
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
		discardModelDraft: vi.fn(),
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
		for (let index = 0; index < 2; index++) app.handleInput("\x1b[B");
		app.handleInput("\x1b[C");
		for (let index = 0; index < 6; index++) app.handleInput("\x1b[B");
		app.handleInput("262144");
		app.handleInput("\r");
		await store.flush();
		app.handleInput("\x1b[D");
		app.handleInput("\x1b[A");
		app.handleInput("\x1b[C"); // → only focuses the fetch pane…
		expect(render(app)).toContain("Fetch the model catalog");
		app.handleInput("\r"); // …Enter starts the request
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
		screen.handleInput("\x1b[C"); // API Auth
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[B"); // API Type row
		screen.handleInput("\r"); // open the radio sub-page
		screen.handleInput("\x1b[A");
		screen.handleInput("\x1b[A"); // not set
		screen.handleInput("\r");
		await store.flush();
		expect(store.getProvider("cpa")?.api).toBe("openai-completions");
		expect(render(screen)).toContain("model-level API");
		screen.dispose();
	});

	test("the API Auth page groups connection fields and opens the API radio", async () => {
		const { screen } = editor();
		screen.handleInput("\x1b[C"); // focus the API Auth pane
		const page = render(screen);
		expect(page).toContain("baseUrl: https://old.example/v1");
		expect(page).toContain("apiKey: not set");
		expect(page).toContain("API Type: openai-completions");
		expect(page).toContain("version path"); // openai-style baseUrl hint
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[B"); // API Type row
		screen.handleInput("\r"); // push the radio sub-page
		expect(render(screen)).toContain("● openai-completions");
		screen.handleInput("\x1b[B"); // anthropic-messages
		screen.handleInput("\r"); // select applies and returns to API Auth
		await store.flush();
		expect(store.getProvider("cpa")?.api).toBe("anthropic-messages");
		const after = render(screen);
		expect(after).toContain("API Type: anthropic-messages");
		expect(after).toContain("bare origin"); // the baseUrl hint follows the API
		screen.dispose();
	});

	test("the provider API unset guard checks every model", async () => {
		store.setModelField("cpa", "k3", ["api"], "anthropic-messages"); // k3 has its own
		store.addModel("cpa", { id: "m2" }); // m2 still inherits
		await store.flush();
		const { host } = hostFixture();
		const pane = new ApiTypePane(host);
		pane.setFocused(true);
		pane.handleInput("\x1b[A");
		pane.handleInput("\x1b[A"); // not set
		pane.handleInput("\r");
		expect(render(pane)).toContain('"m2"');
		expect(store.getProvider("cpa")?.api).toBe("openai-completions");
	});

	test("the Model-Specific API page inherits dimmed values and overrides on input", async () => {
		const { host, model } = hostFixture();
		const pane = new ModelSpecificApiPane(host, model);
		pane.setFocused(true);
		expect(render(pane)).toContain("https://old.example/v1");
		expect(render(pane)).toContain("· provider");
		pane.handleInput("https://new.example/v1"); // typing overwrites the inherited value
		pane.handleInput("\r");
		await store.flush();
		expect(store.getModel("cpa", "k3")?.baseUrl).toBe("https://new.example/v1");
		pane.handleInput("\r"); // tweak the override
		pane.handleInput("\x15"); // ctrl+u clears it
		pane.handleInput("\r");
		await store.flush();
		expect(store.getModel("cpa", "k3")?.baseUrl).toBeUndefined(); // back to inheriting
		expect(render(pane)).toContain("· provider");
	});

	test("the model API radio sets an override and refuses inheritance with no fallback", async () => {
		const { host, model } = hostFixture();
		const pane = new ModelApiTypePane(host, model);
		pane.setFocused(true);
		expect(render(pane)).toContain("provider: openai-completions");
		for (let index = 0; index < 3; index++) pane.handleInput("\x1b[B"); // anthropic-messages
		pane.handleInput("\r");
		await store.flush();
		expect(store.getModel("cpa", "k3")?.api).toBe("anthropic-messages");
		expect(host.popPane).toHaveBeenCalled();
		// With neither a provider API nor a built-in fallback, the inherit option is guarded.
		store.setProviderField("cpa", ["api"], DELETE);
		store.setModelField("cpa", "k3", ["api"], DELETE);
		await store.flush();
		const bare = new ModelApiTypePane(host, model);
		bare.setFocused(true);
		bare.handleInput("\r"); // first option: nothing to inherit
		expect(render(bare)).toContain("Nothing to inherit");
		expect(store.getModel("cpa", "k3")?.api).toBeUndefined();
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

	test("→ on an action row only focuses its pane; Enter activates it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "remote-1" }] }))),
		);
		const { screen } = editor();
		screen.handleInput("\x1b[B"); // Fetch Models row
		screen.handleInput("\x1b[C");
		expect(render(screen)).toContain("Fetch the model catalog"); // idle, no request fired
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		screen.handleInput("\r");
		await vi.waitFor(() => expect(render(screen)).toContain("remote-1"));
		screen.handleInput("\x1b"); // discard results → left focus
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[B"); // + Add Model
		screen.handleInput("\x1b[C");
		expect(render(screen)).toContain("Press Enter to create a model.");
		expect(render(screen)).not.toContain("· draft");
		screen.handleInput("\r"); // Enter on the focused info pane activates the row
		expect(render(screen)).toContain("New Model");
		screen.dispose();
	});

	test("Enter on the fetch results imports the highlighted row when nothing is checked", async () => {
		const { host } = hostFixture();
		const imported: string[][] = [];
		host.importModels = async (models) => {
			imported.push(models.map((model) => model.id));
			return undefined;
		};
		const pane = new FetchModelsPane(host);
		pane.setFocused(true);
		pane.start();
		await vi.waitFor(() => expect(render(pane)).toContain("new-model"));
		pane.handleInput("\r");
		await vi.waitFor(() => expect(imported).toEqual([["new-model"]]));
		pane.dispose();
	});

	test("Enter on an already-added fetch row is a no-op, not a discard", async () => {
		const { host } = hostFixture();
		host.runFetch = async () => ({ ok: true, models: [{ id: "k3" }], truncated: false });
		const importModels = vi.fn(async () => undefined);
		host.importModels = importModels;
		const pane = new FetchModelsPane(host);
		pane.setFocused(true);
		pane.start();
		await vi.waitFor(() => expect(render(pane)).toContain("Added"));
		pane.handleInput("\r");
		expect(importModels).not.toHaveBeenCalled();
		expect(host.popPane).not.toHaveBeenCalled(); // results stay open; only Esc discards
		pane.dispose();
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

describe("provider fixed layout", () => {
	test("windowLines pads short content and clips around the cursor with an indicator", () => {
		expect(windowLines(theme, ["a", "b"], 4)).toEqual(["a", "b", "", ""]);
		const rows = Array.from({ length: 10 }, (_, index) => `row ${index}`);
		const top = windowLines(theme, rows, 5, { cursor: 0 }).map(stripAnsi);
		expect(top).toEqual(["row 0", "row 1", "row 2", "row 3", "  (1/10)"]);
		const bottom = windowLines(theme, rows, 5, { cursor: 9 }).map(stripAnsi);
		expect(bottom).toEqual(["row 6", "row 7", "row 8", "row 9", "  (10/10)"]);
		// Pinned lines survive clipping.
		const pinned = windowLines(theme, rows, 5, { top: 1, bottom: 1, cursor: 9 }).map(stripAnsi);
		expect(pinned).toEqual(["row 0", "row 7", "row 8", "  (8/8)", "row 9"]);
	});

	test("the editor frame height stays fixed while navigating", () => {
		const { screen } = editor();
		const height = screen.render(120).length;
		expect(height).toBe(20);
		for (let index = 0; index < 6; index++) screen.handleInput("\x1b[B");
		expect(screen.render(120).length).toBe(height);
		screen.handleInput("\x1b[C"); // focus the right column
		expect(screen.render(120).length).toBe(height);
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[A");
		expect(screen.render(120).length).toBe(height);
		screen.dispose();
	});

	test("the selection path stays highlighted in the unfocused pane", () => {
		const { screen } = editor();
		const focusedLeft = screen.render(120).join("\n");
		expect(focusedLeft).toContain(theme.fg("accent", "API Auth"));
		expect(focusedLeft).toContain(theme.fg("text", "Fetch Models"));
		// The unfocused right pane previews with only its active row lit.
		expect(focusedLeft).toContain(theme.fg("accent", "baseUrl: "));
		expect(focusedLeft).toContain(theme.fg("dim", "API Type: "));
		screen.handleInput("\x1b[C"); // focus moves right
		const focusedRight = screen.render(120).join("\n");
		expect(focusedRight).toContain(theme.fg("accent", "API Auth"));
		expect(focusedRight).toContain(theme.fg("dim", "Fetch Models"));
		expect(focusedRight).toContain(theme.fg("text", "API Type: "));
		screen.dispose();
	});

	test("the left column scrolls with a position indicator", () => {
		for (let index = 0; index < 14; index++) store.addModel("cpa", { id: `m${index}` });
		const { screen } = editor();
		expect(render(screen)).toContain("(1/19)");
		expect(screen.render(120).length).toBe(20);
		for (let index = 0; index < 3; index++) screen.handleInput("\x1b[B");
		expect(render(screen)).toContain("(4/19)");
		expect(screen.render(120).length).toBe(20);
		screen.dispose();
	});

	test("fetch results scroll inside the fixed window with a position indicator", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ data: Array.from({ length: 15 }, (_, index) => ({ id: `remote-${index}` })) }),
					),
			),
		);
		const { screen } = editor();
		screen.handleInput("\x1b[B"); // Fetch Models row
		screen.handleInput("\r"); // focus right and start the request
		await vi.waitFor(() => expect(render(screen)).toContain("(1/15)"));
		expect(screen.render(120).length).toBe(20);
		// The filter input stays pinned above the scrolled rows.
		expect(render(screen)).toContain("0 selected · 15 shown");
		screen.handleInput("\x1b[B");
		expect(render(screen)).toContain("(2/15)");
		expect(screen.render(120).length).toBe(20);
		screen.dispose();
	});

	test("the provider list keeps a fixed frame in list, empty, and id-entry modes", () => {
		const list = new ProviderListScreen(tui, theme, keys, vi.fn(), store);
		list.focused = true;
		expect(list.render(120).length).toBe(20);
		list.handleInput("zzz"); // filter to no match
		expect(list.render(120).length).toBe(20);
		list.handleInput("\r"); // + Add Provider → id entry mode, prefilled from the query
		expect(list.render(120).length).toBe(20);
		expect(stripAnsi(list.render(120).join("\n"))).toContain("zzz");
		list.handleInput("\x15"); // ctrl+u clears the prefilled id
		list.handleInput("\r"); // empty id → inline error, still fixed height
		expect(stripAnsi(list.render(120).join("\n"))).toContain("non-empty");
		expect(list.render(120).length).toBe(20);
	});

	test("the provider list scrolls with a position indicator", () => {
		for (let index = 0; index < 15; index++) store.ensureProviderView(`p${index}`);
		const list = new ProviderListScreen(tui, theme, keys, vi.fn(), store);
		list.focused = true;
		expect(stripAnsi(list.render(120).join("\n"))).toContain("(1/17)");
		expect(list.render(120).length).toBe(20);
		for (let index = 0; index < 16; index++) list.handleInput("\x1b[B");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("(17/17)");
		expect(list.render(120).length).toBe(20);
	});

	test("Esc on a fresh model draft discards it in one step", () => {
		const { screen } = editor();
		for (let index = 0; index < 3; index++) screen.handleInput("\x1b[B"); // + Add Model
		screen.handleInput("\r"); // creates the draft and opens id editing
		expect(render(screen)).toContain("New Model");
		screen.handleInput("\x1b"); // cancels id editing → the empty draft is discarded
		expect(render(screen)).not.toContain("New Model");
		expect(render(screen)).toContain("› + Add Model");
		expect(screen.render(120).length).toBe(20);
		screen.dispose();
	});

	test("Esc on a draft with fields asks before discarding", async () => {
		const { screen } = editor();
		for (let index = 0; index < 3; index++) screen.handleInput("\x1b[B");
		screen.handleInput("\r");
		screen.handleInput("k3"); // duplicate id
		screen.handleInput("\r"); // the commit fails; the draft keeps the id
		expect(render(screen)).toContain("already exists");
		screen.handleInput("\x1b"); // cancels the edit; the non-empty draft stays
		expect(render(screen)).toContain("· draft");
		screen.handleInput("\x1b"); // asks before discarding
		expect(render(screen)).toContain("Discard the new model");
		screen.handleInput("\x1b[A"); // Discard Model
		screen.handleInput("\r");
		expect(render(screen)).not.toContain("· draft");
		expect(render(screen)).toContain("› + Add Model");
		screen.dispose();
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
