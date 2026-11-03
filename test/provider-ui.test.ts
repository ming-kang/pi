import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AuthInteraction, AuthType, Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CredentialSummary } from "../src/core/credential-summary.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { AuthStatus } from "../src/core/provider-composer.ts";
import { compatFieldsForApi } from "../src/extensions/provider/compat-fields.ts";
import { ProviderEdits } from "../src/extensions/provider/editing.ts";
import { RefreshCoordinator } from "../src/extensions/provider/refresh.ts";
import { DELETE, ModelsJsonStore } from "../src/extensions/provider/store.ts";
import { MODEL_ADVANCED_FIELDS, parseAdvancedValue } from "../src/extensions/provider/ui/advanced.ts";
import { createProviderApp, createProviderErrorScreen } from "../src/extensions/provider/ui/app.ts";
import { BuiltinPreviewPane } from "../src/extensions/provider/ui/builtin-data.ts";
import { CompatKeyPickerPane, CompatPane } from "../src/extensions/provider/ui/compat.ts";
import { credentialSource } from "../src/extensions/provider/ui/credential.ts";
import { ProviderEditorScreen } from "../src/extensions/provider/ui/editor.ts";
import { FetchModelsPane } from "../src/extensions/provider/ui/fetch-models.ts";
import { parseTokenCount } from "../src/extensions/provider/ui/model-fields.ts";
import { CostPane, createModelApiPane, ModelSpecificApiPane } from "../src/extensions/provider/ui/model-options.ts";
import type { EditorHost, ModelHandle } from "../src/extensions/provider/ui/pane.ts";
import { createProviderApiPane } from "../src/extensions/provider/ui/provider-fields.ts";
import { ProviderListScreen } from "../src/extensions/provider/ui/provider-list.ts";
import { ThinkingMapPane } from "../src/extensions/provider/ui/thinking-map.ts";
import { renderErrorLines, windowLines } from "../src/extensions/provider/ui/value-row.ts";
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
		getProviderAuthStatus: (): AuthStatus => ({ configured: false }),
		isUsingOAuth: (_providerId: string) => false,
		describeCredential: vi.fn(async (_providerId: string): Promise<CredentialSummary | undefined> => undefined),
		login: vi.fn(async (_providerId: string, _type: AuthType, _interaction: AuthInteraction) => ({
			type: "api_key" as const,
			key: "",
		})),
		logout: vi.fn(async (_providerId: string) => {}),
	};
}

function listContext(configured: string[] = [], auth: Record<string, string> = {}) {
	return { configured, authNote: (id: string) => auth[id] };
}

function editor(providerId = "cpa", runtime: ReturnType<typeof runtimeStub> = runtimeStub()) {
	const done = vi.fn();
	const screen = new ProviderEditorScreen(tui, theme, keys, done, {
		store,
		providerId,
		runtime,
		refresher: new RefreshCoordinator(runtime),
		notify: vi.fn(),
	});
	screen.focused = true;
	return { screen, done };
}

function hostFixture(): { host: EditorHost; model: ModelHandle } {
	const host: EditorHost = {
		theme,
		keybindings: keys,
		store,
		providerId: "cpa",
		edits: new ProviderEdits(store, "cpa", new RefreshCoordinator(runtimeStub()), vi.fn()),
		pushPane: vi.fn(),
		popPane: vi.fn(),
		refresh: vi.fn(),
		notify: vi.fn(),
		effectiveApi: () => "openai-completions",
		effectiveBaseUrl: () => "https://old.example/v1",
		commitModelDraft: () => undefined,
		discardModelDraft: vi.fn(),
		isCurrentModel: () => false,
		setFetchStatus: vi.fn(),
		runFetch: async () => ({ ok: true, models: [{ id: "new-model" }], truncated: false }),
		importModels: async () => undefined,
		confirm: vi.fn(),
		onModelRemoved: vi.fn(),
		openOverride: vi.fn(),
	};
	const read = () => store.getModel("cpa", "k3") ?? {};
	const model: ModelHandle = {
		kind: "custom",
		read,
		own: read,
		base: () => undefined,
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
	test("the list ignores the model in use: an unconfigured built-in stays under More", () => {
		const runtime = runtimeStub();
		const app = createProviderApp(tui, theme, keys, vi.fn(), {
			store,
			runtime,
			registry: { find: () => undefined },
			getCurrentModel: () => ({ provider: "openai", id: "gpt-4o" }),
			setModel: vi.fn(async () => true),
			notify: vi.fn(),
		});
		const text = render(app);
		expect(text).not.toContain("openai");
		expect(text).not.toContain("in use");
		expect(text).toContain("More built-in providers");
		app.dispose();
	});

	test("opening an unconfigured built-in and leaving untouched keeps it off the main list", () => {
		const app = createProviderApp(tui, theme, keys, vi.fn(), {
			store,
			runtime: runtimeStub(),
			registry: { find: () => undefined },
			getCurrentModel: () => undefined,
			setModel: vi.fn(async () => true),
			notify: vi.fn(),
		});
		app.handleInput("openai");
		app.handleInput("\r");
		expect(render(app)).toContain("Providers / openai");
		app.handleInput("\x1b"); // back to the list without a change
		const text = render(app);
		expect(text).toContain("Search:");
		expect(text).not.toContain("openai");
		app.dispose();
	});

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
		expect(render(app)).toContain("· from https://old.example");
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
	test("API selection uses remapped navigation and confirmation keys", async () => {
		const { host } = hostFixture();
		const remapped = new KeybindingsManager({ "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+y" });
		const pane = createProviderApiPane({ ...host, keybindings: remapped });
		pane.handleInput("\x0e");
		pane.handleInput("\x19");
		await store.flush();
		expect(store.getProvider("cpa")?.api).toBe("anthropic-messages");
		expect(host.popPane).toHaveBeenCalledOnce();
	});
	test("an invalid cost edit can be cancelled without changing the value or leaving editing focus behind", async () => {
		const { host, model } = hostFixture();
		const pane = new CostPane(host, model);
		pane.setFocused(true);
		pane.handleInput("-1");
		pane.handleInput("\r");
		expect(render(pane)).toContain("non-negative");
		expect(pane.isEditing()).toBe(true);
		pane.handleInput("\x1b");
		expect(pane.isEditing()).toBe(false);
		expect(model.read().cost).toBeUndefined();
		pane.handleInput("\x1b[B");
		pane.handleInput("\x1b[200~2.5\x1b[201~");
		pane.handleInput("\r");
		await store.flush();
		expect(model.read().cost).toEqual({ input: 0, output: 2.5, cacheRead: 0, cacheWrite: 0 });
	});

	test("built-in application merges nested entries and preserves existing cost tiers", async () => {
		const tiers = [{ inputTokensAbove: 1000, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }];
		store.setModelField("cpa", "k3", ["cost"], { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers });
		store.setModelField("cpa", "k3", ["compat"], {
			chatTemplateKwargs: { keep: "yes", replace: "old" },
			supportsStore: true,
		});
		await store.flush();
		const { host, model } = hostFixture();
		const reference: Model<"openai-completions"> = {
			id: "reference",
			name: "Reference",
			provider: "reference",
			api: "openai-completions",
			baseUrl: "https://example.test",
			reasoning: true,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 1000,
			compat: { chatTemplateKwargs: { replace: "new", added: true } },
			cost: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6, tiers: [] },
		};
		const pane = new BuiltinPreviewPane(host, model, { providerId: "reference", model: reference });
		for (let i = 0; i < 5; i++) pane.handleInput("\x1b[B");
		pane.handleInput(" "); // compat
		pane.handleInput("\x1b[B");
		pane.handleInput(" "); // cost
		pane.handleInput("\x1b[B");
		pane.handleInput("\r"); // apply
		await store.flush();
		expect(model.read().compat).toEqual({
			chatTemplateKwargs: { keep: "yes", replace: "new", added: true },
			supportsStore: true,
		});
		expect(model.read().cost).toEqual({ input: 9, output: 8, cacheRead: 7, cacheWrite: 6, tiers });
		expect(model.read().id).toBe("k3");
	});

	test("a superseded discovery cannot replace the latest results", async () => {
		const { host } = hostFixture();
		let resolveFirst!: (result: Awaited<ReturnType<EditorHost["runFetch"]>>) => void;
		let calls = 0;
		host.runFetch = () =>
			++calls === 1
				? new Promise((resolve) => {
						resolveFirst = resolve;
					})
				: Promise.resolve({ ok: true, models: [{ id: "latest" }], truncated: false });
		const pane = new FetchModelsPane(host);
		pane.start();
		pane.handleInput("\x1b");
		pane.start();
		await vi.waitFor(() => expect(render(pane)).toContain("latest"));
		resolveFirst({ ok: true, models: [{ id: "stale" }], truncated: false });
		await Promise.resolve();
		expect(render(pane)).not.toContain("stale");
		pane.dispose();
	});

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
		screen.handleInput("\x1b[C"); // Authentication
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

	test("the Authentication page groups connection fields and opens the API radio", async () => {
		const { screen } = editor();
		screen.handleInput("\x1b[C"); // focus the Authentication pane
		const page = render(screen);
		expect(page).toContain("SETUP");
		expect(page).toContain("MODELS");
		expect(page).toContain("MANAGE");
		expect(page).toContain("Authentication");
		expect(page).toContain("baseUrl: https://old.example/v1");
		expect(page).toContain("apiKey: not set");
		expect(page).toContain("API Type: openai-completions");
		expect(page).toContain("version path"); // openai-style baseUrl hint
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[B"); // API Type row
		screen.handleInput("\r"); // push the radio sub-page
		expect(render(screen)).toContain("Authentication / API Type");
		expect(render(screen)).toContain("● openai-completions");
		screen.handleInput("\x1b[B"); // anthropic-messages
		screen.handleInput("\r"); // select applies and returns to Authentication
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
		const pane = createProviderApiPane(host);
		pane.setFocused(true);
		pane.handleInput("\x1b[A");
		pane.handleInput("\x1b[A"); // not set
		pane.handleInput("\r");
		expect(render(pane)).toContain('"m2"');
		expect(store.getProvider("cpa")?.api).toBe("openai-completions");
	});

	test("the Model-specific API page inherits dimmed values and overrides on input", async () => {
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
		const pane = createModelApiPane(host, model);
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
		const bare = createModelApiPane(host, model);
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
		screen.handleInput("\x1b[B"); // Fetch models row
		screen.handleInput("\x1b[C");
		expect(render(screen)).toContain("· from https://old.example"); // idle, no request fired
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		screen.handleInput("\r");
		await vi.waitFor(() => expect(render(screen)).toContain("remote-1"));
		screen.handleInput("\x1b"); // discard results → left focus
		screen.handleInput("\x1b[B");
		screen.handleInput("\x1b[B"); // + Add model
		screen.handleInput("\x1b[C");
		expect(render(screen)).toContain("Press Enter to create a model.");
		expect(render(screen)).not.toContain("· draft");
		screen.handleInput("\r"); // Enter on the focused info pane activates the row
		expect(render(screen)).toContain("New model");
		expect(render(screen)).toContain("enter save"); // the draft opens with its id field editing
		expect(render(screen)).not.toContain("back to list"); // ← moves the text cursor there
		screen.dispose();
	});

	test("→ on the fetch row lights the idle action row; Enter on it starts the request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "remote-1" }] }))),
		);
		const { screen } = editor();
		screen.handleInput("\x1b[B"); // Fetch models row
		const preview = screen.render(120).join("\n");
		expect(preview).toContain("· from https://old.example");
		expect(preview).not.toContain(theme.fg("accent", "Fetch models ·")); // preview carries no marker
		screen.handleInput("\x1b[C"); // focus the pane without firing
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		const focused = screen.render(120).join("\n");
		expect(focused).toContain(theme.fg("accent", "Fetch models")); // the idle row lights up
		expect(focused).toContain("back to list");
		screen.handleInput("\r"); // Enter on the idle row fires
		await vi.waitFor(() => expect(render(screen)).toContain("remote-1"));
		expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
		screen.dispose();
	});

	test("the fetch pane dead-ends cleanly without a baseUrl", async () => {
		vi.stubGlobal("fetch", vi.fn());
		store.setProviderField("cpa", ["baseUrl"], DELETE);
		await store.flush();
		const { screen } = editor();
		screen.handleInput("\x1b[B"); // Fetch models row
		screen.handleInput("\r"); // left-row Enter is guarded too
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		const page = render(screen);
		expect(page).toContain("Set a baseUrl under Authentication first.");
		expect(page).not.toContain("enter fetch"); // no phantom action in the footer
		screen.handleInput("\r"); // pane Enter dead-ends instead of erroring
		expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		expect(render(screen)).not.toContain("Enter retries");
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
		await vi.waitFor(() => expect(host.popPane).toHaveBeenCalledOnce());
		expect(render(pane)).not.toContain("Importing");
		pane.dispose();
	});

	test("fetch results summarize the metadata each model declared", async () => {
		const { host } = hostFixture();
		host.runFetch = async () => ({
			ok: true,
			models: [
				{
					id: "deepseek-flash",
					name: "DeepSeek-V4.1-Flash",
					contextWindow: 1048576,
					maxTokens: 393216,
					input: ["text", "image"],
					reasoning: true,
				},
				{ id: "plain" },
			],
			truncated: false,
		});
		const pane = new FetchModelsPane(host);
		pane.setFocused(true);
		pane.start();
		await vi.waitFor(() =>
			expect(render(pane)).toContain("deepseek-flash · DeepSeek-V4.1-Flash · 1.0M ctx · 393k out · img · think"),
		);
		const plain = render(pane)
			.split("\n")
			.find((line) => line.includes("plain"));
		expect(plain?.trimEnd()).toMatch(/\[ \] plain$/);
		expect(host.setFetchStatus).toHaveBeenLastCalledWith("· 2 found");
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
		await vi.waitFor(() => expect(render(pane)).toContain("· added"));
		pane.handleInput("\r");
		expect(importModels).not.toHaveBeenCalled();
		expect(host.popPane).not.toHaveBeenCalled(); // results stay open; only Esc discards
		pane.dispose();
	});

	test("the Fetch models row counts what was imported, not the provider total", async () => {
		const { host } = hostFixture();
		host.importModels = vi.fn(async () => undefined);
		const pane = new FetchModelsPane(host);
		pane.setFocused(true);
		pane.start();
		await vi.waitFor(() => expect(render(pane)).toContain("new-model"));
		pane.handleInput("\r"); // nothing checked: imports the highlighted row
		await vi.waitFor(() => expect(host.setFetchStatus).toHaveBeenLastCalledWith("· 1 imported"));
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
		screen.handleInput("\x1b[B"); // Fetch models row
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
		const list = new ProviderListScreen(tui, theme, keys, vi.fn(), store, listContext());
		list.focused = true;
		const initial = stripAnsi(list.render(120).join("\n"));
		expect(initial).toContain("Providers");
		expect(initial).not.toContain("models.json");
		expect(initial).not.toContain("1 model");
		expect(initial).not.toContain("openai-completions");
		expect(list.render(120).length).toBe(20);
		list.handleInput("zzz"); // filter to no match
		expect(list.render(120).length).toBe(20);
		expect(stripAnsi(list.render(120).join("\n"))).toContain('No providers match "zzz".');
		expect(stripAnsi(list.render(120).join("\n"))).toContain('Enter will create provider "zzz".');
		list.handleInput("\x15"); // ctrl+u clears the query
		list.handleInput("\r"); // + Add Provider without a query → id entry mode
		expect(list.render(120).length).toBe(20);
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Choose a unique provider id.");
		list.handleInput("\r"); // empty id → inline error, still fixed height
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Provider id is required.");
		expect(list.render(120).length).toBe(20);
	});

	test('an id with "/" stays in id entry with the reason instead of creating a provider', () => {
		const done = vi.fn();
		const list = new ProviderListScreen(tui, theme, keys, done, store, listContext());
		list.focused = true;
		list.handleInput("/provider"); // e.g. a slash command typed into the open panel
		list.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		expect(store.getProviderIds()).not.toContain("/provider");
		const text = stripAnsi(list.render(120).join("\n"));
		expect(text).toContain("Providers / New provider");
		expect(text).toContain('Provider ids cannot start with "/".');
		expect(text).not.toContain("This becomes the providers");
	});

	test("a search that can never be an id says so instead of promising to create it", () => {
		const list = new ProviderListScreen(tui, theme, keys, vi.fn(), store, listContext());
		list.focused = true;
		list.handleInput("my proxy");
		const text = stripAnsi(list.render(120).join("\n"));
		expect(text).toContain("Provider ids cannot contain spaces.");
		expect(text).not.toContain("Enter will create");
	});

	test("an inner slash is a valid id now that provider/model references match known ids", () => {
		const list = new ProviderListScreen(tui, theme, keys, vi.fn(), store, listContext());
		list.focused = true;
		list.handleInput("acme/eu");
		const text = stripAnsi(list.render(120).join("\n"));
		expect(text).toContain('Enter will create provider "acme/eu".');
		expect(text).not.toContain("cannot");
	});

	test("a fruitless search creates the provider in one Enter and opens at its API type", async () => {
		const done = vi.fn();
		const list = new ProviderListScreen(tui, theme, keys, done, store, listContext());
		list.focused = true;
		list.handleInput("my-gw");
		list.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ kind: "open", providerId: "my-gw" });

		const { screen } = editor("my-gw");
		const picker = render(screen);
		expect(picker).toContain("Authentication / API Type");
		expect(picker).toContain("› ○ openai-completions · OpenAI-compatible");
		screen.handleInput("\r");
		expect(store.getProvider("my-gw")).toEqual({ api: "openai-completions" });
		await store.flush();
		// An API type alone is held back until baseUrl, so the title does not claim a save.
		expect(render(screen).split("\n")[1]).not.toContain("Saving…");
		const connection = render(screen);
		expect(connection).not.toContain("/ API Type");
		// baseUrl is already open, showing the expected shape until the paste.
		expect(connection).toMatch(/› baseUrl: .*ttps:\/\/api\.example\.com\/v1/);
		screen.handleInput("\x1b[200~http://localhost:11434/v1\x1b[201~");
		screen.handleInput("\r");
		// The first baseUrl leads straight on to an empty apiKey.
		expect(render(screen)).toMatch(/› apiKey: .*k-…, \$ENV_VAR, or !command/);
		screen.handleInput("\x1b[200~sk-demo-0000000000wxyz\x1b[201~");
		screen.handleInput("\r");
		expect(store.getProvider("my-gw")).toEqual({
			api: "openai-completions",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "sk-demo-0000000000wxyz",
		});
		expect(render(screen)).toContain("› apiKey: ••••••wxyz");
		screen.dispose();
	});

	test("re-editing an existing baseUrl does not jump to apiKey", () => {
		const { screen } = editor();
		screen.handleInput("\x1b[C");
		screen.handleInput("\x1b[200~https://new.example/v1\x1b[201~");
		screen.handleInput("\r");
		expect(render(screen)).toContain("› baseUrl: https://new.example/v1");
		screen.dispose();
	});

	test("leaving a new provider that holds only an API type drops it", () => {
		store.ensureProviderView("half");
		const { screen, done } = editor("half");
		screen.handleInput("\r"); // choose the suggested API; baseUrl opens for editing
		screen.handleInput("\x1b"); // leave baseUrl empty
		screen.handleInput("\x1b"); // right pane → navigation
		screen.handleInput("\x1b"); // navigation → back
		expect(done).toHaveBeenCalledWith("back");
		screen.dispose(); // the app disposes the editor as it returns to the list
		expect(store.getProvider("half")).toBeUndefined();
		expect(store.pendingCount).toBe(0);
	});

	test("the narrow editor shows only the focused pane and preserves its fixed frame", () => {
		const { screen } = editor();
		const navigation = screen.render(56);
		expect(navigation.length).toBe(20);
		expect(stripAnsi(navigation.join("\n"))).toContain("SETUP");
		expect(stripAnsi(navigation.join("\n"))).not.toContain("baseUrl");
		expect(stripAnsi(navigation.join("\n"))).not.toContain("│");
		expect(navigation.every((line) => visibleWidth(stripAnsi(line)) <= 56)).toBe(true);

		screen.handleInput("\x1b[C");
		const details = screen.render(56);
		expect(details.length).toBe(20);
		expect(stripAnsi(details.join("\n"))).toContain("Authentication");
		expect(stripAnsi(details.join("\n"))).toContain("baseUrl: https://old.example/v1");
		expect(stripAnsi(details.join("\n"))).not.toContain("MANAGE");
		expect(details.every((line) => visibleWidth(stripAnsi(line)) <= 56)).toBe(true);

		screen.handleInput("\x1b");
		const returned = stripAnsi(screen.render(56).join("\n"));
		expect(returned).toContain("MANAGE");
		expect(returned).not.toContain("baseUrl");
		screen.dispose();
	});

	test("the editor title reports saving and failed-save states", async () => {
		const initial = readFileSync(store.path, "utf8");
		const { screen } = editor();
		writeFileSync(store.path, "{ broken JSON");
		screen.handleInput("\x1b[C");
		screen.handleInput("\x1b[200~https://new.example/v1\x1b[201~");
		screen.handleInput("\r");
		expect(render(screen)).toContain("Saving…");
		await store.flush();
		screen.syncFromStore();
		expect(render(screen)).toContain("Save failed");

		writeFileSync(store.path, initial);
		store.retrySave();
		await store.flush();
		screen.syncFromStore();
		expect(render(screen)).not.toContain("Saving…");
		expect(render(screen)).not.toContain("Save failed");
		screen.dispose();
	});

	test("the provider list scrolls with a position indicator", () => {
		for (let index = 0; index < 15; index++) store.ensureProviderView(`p${index}`);
		const list = new ProviderListScreen(tui, theme, keys, vi.fn(), store, listContext());
		list.focused = true;
		expect(stripAnsi(list.render(120).join("\n"))).toContain("(1/18)");
		expect(list.render(120).length).toBe(20);
		for (let index = 0; index < 17; index++) list.handleInput("\x1b[B");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("(18/18)");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("More built-in providers");
		expect(list.render(120).length).toBe(20);
	});

	test("Esc on a fresh model draft discards it in one step", () => {
		const { screen } = editor();
		for (let index = 0; index < 3; index++) screen.handleInput("\x1b[B"); // + Add model
		screen.handleInput("\r"); // creates the draft and opens id editing
		expect(render(screen)).toContain("New model");
		screen.handleInput("\x1b"); // cancels id editing → the empty draft is discarded
		expect(render(screen)).not.toContain("New model");
		expect(render(screen)).toContain("› + Add model");
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
		screen.handleInput("\x1b[A"); // Discard model
		screen.handleInput("\r");
		expect(render(screen)).not.toContain("· draft");
		expect(render(screen)).toContain("› + Add model");
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

describe("built-in providers", () => {
	test("credentialSource names where a built-in's key comes from", () => {
		const runtime = (status: AuthStatus, oauth = false) => ({
			getProviderAuthStatus: () => status,
			isUsingOAuth: () => oauth,
		});
		expect(credentialSource(runtime({ configured: true, source: "stored" }), "deepseek")).toBe("API key");
		expect(credentialSource(runtime({ configured: true, source: "stored" }, true), "kimi-coding")).toBe("OAuth");
		expect(
			credentialSource(runtime({ configured: true, source: "environment", label: "DEEPSEEK_API_KEY" }), "deepseek"),
		).toBe("env DEEPSEEK_API_KEY");
		expect(credentialSource(runtime({ configured: false }), "openai")).toBeUndefined();
	});

	test("the list shows configured built-ins and keeps the rest under More built-in providers", () => {
		const done = vi.fn();
		const list = new ProviderListScreen(
			tui,
			theme,
			keys,
			done,
			store,
			listContext(["deepseek", "kimi-coding"], { deepseek: "API key", "kimi-coding": "OAuth" }),
		);
		list.focused = true;
		const initial = stripAnsi(list.render(120).join("\n"));
		expect(initial).toMatch(/ cpa\n/);
		expect(initial).toContain("deepseek · built-in · API key\n");
		expect(initial).toContain("kimi-coding · built-in · OAuth");
		expect(initial).toMatch(/\n\n {2}More built-in providers · \d+/);
		expect(initial).not.toContain("openai");
		// The More row is last; Enter opens the unconfigured built-ins with their own search.
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		const more = stripAnsi(list.render(120).join("\n"));
		expect(more).toContain("Providers / More built-in providers");
		expect(more).toMatch(/anthropic · \d+ models/);
		expect(more).not.toContain("deepseek");
		expect(more).not.toContain("+ Add provider");
		list.handleInput("anthropic");
		list.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ kind: "open", providerId: "anthropic" });
	});

	test("Esc leaves More built-in providers on its row, and a main-list search reaches unconfigured built-ins", () => {
		const done = vi.fn();
		const list = new ProviderListScreen(tui, theme, keys, done, store, listContext(["deepseek"]));
		list.focused = true;
		list.handleInput("\x1b[A");
		list.handleInput("\r");
		list.handleInput("\x1b");
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(/› More built-in providers/);
		expect(done).not.toHaveBeenCalled();

		list.handleInput("openrouter");
		const found = stripAnsi(list.render(120).join("\n"));
		expect(found).toContain("› openrouter · built-in · not configured");
		expect(found).not.toContain("More built-in providers");
		list.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ kind: "open", providerId: "openrouter" });
	});

	test("a built-in's Authentication page shows the saved key masked and replaces it like /login", async () => {
		const runtime = runtimeStub();
		runtime.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
		runtime.describeCredential.mockResolvedValue({ type: "api_key", keyHint: "abcd" });
		store.ensureProviderView("deepseek");
		const { screen } = editor("deepseek", runtime);
		screen.handleInput("\x1b[C");
		await vi.waitFor(() => expect(render(screen)).toContain("› Credential: API key ••••abcd · saved by /login"));
		const page = render(screen);
		expect(page).toContain("Log out · removes the saved key");
		expect(page).not.toContain("apiKey:");
		expect(page).not.toContain("Saved as typed");

		screen.handleInput("$DEEPSEEK_KEY");
		screen.handleInput("\r");
		expect(render(screen)).toContain("Enter the key itself");
		screen.handleInput("\x1b");

		screen.handleInput("\x1b[200~sk-demo-0000000000wxyz\x1b[201~");
		screen.handleInput("\r");
		await vi.waitFor(() => expect(render(screen)).toContain("Key saved to auth.json."));
		const [providerId, type, interaction] = runtime.login.mock.calls[0]!;
		expect([providerId, type]).toEqual(["deepseek", "api_key"]);
		await expect(interaction.prompt({ type: "secret", message: "Enter DeepSeek API key" })).resolves.toBe(
			"sk-demo-0000000000wxyz",
		);
		await expect(interaction.prompt({ type: "text", message: "Region" })).rejects.toThrow("/login deepseek");
		screen.dispose();
	});

	test("an OAuth built-in shows the login and logs out after a confirm", async () => {
		const runtime = runtimeStub();
		runtime.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
		runtime.isUsingOAuth = () => true;
		runtime.describeCredential.mockResolvedValue({
			type: "oauth",
			account: "ming@example.com",
			expires: Date.now() + 86_400_000,
		});
		store.ensureProviderView("kimi-coding");
		const { screen } = editor("kimi-coding", runtime);
		screen.handleInput("\x1b[C");
		await vi.waitFor(() => expect(render(screen)).toMatch(/Credential: OAuth · ming@example\.com · expires \d{4}-/));
		expect(render(screen)).toContain("/login kimi-coding signs in again.");
		expect(render(screen)).toContain("type to use an API key");
		screen.handleInput("\x1b[B"); // Log out
		screen.handleInput("\r");
		expect(render(screen)).toContain("This removes its OAuth login from auth.json.");
		screen.handleInput("\x1b[A"); // Log out, not the default Cancel
		screen.handleInput("\r");
		await vi.waitFor(() => expect(render(screen)).toContain("Logged out"));
		expect(runtime.logout).toHaveBeenCalledWith("kimi-coding");
		screen.dispose();
	});

	test("a built-in keyed by the environment names the variable and offers no Log out", () => {
		const runtime = runtimeStub();
		runtime.getProviderAuthStatus = () => ({ configured: true, source: "environment", label: "DEEPSEEK_API_KEY" });
		store.ensureProviderView("deepseek");
		const { screen } = editor("deepseek", runtime);
		screen.handleInput("\x1b[C");
		const page = render(screen);
		expect(page).toContain("Credential: from env DEEPSEEK_API_KEY");
		expect(page).not.toContain("Log out");
		expect(page).not.toContain("An environment variable");
		screen.dispose();
	});

	test("a built-in opens without an entry, edits a catalog model as an override, and resets", async () => {
		store.ensureProviderView("deepseek");
		const { screen } = editor("deepseek");
		const modelRow = /^\s+DeepSeek V4 Pro\s+│/m;
		const initial = render(screen);
		expect(initial).not.toContain("Fetch models");
		expect(initial).toContain("Built-in models · 2");
		expect(initial).toContain("Reset provider");
		screen.handleInput("\x1b[C");
		expect(render(screen)).toMatch(/baseUrl: https:\/\/api\.deepseek\.com.* · built-in/);
		expect(render(screen)).not.toContain("(built-in)");
		expect(render(screen)).not.toContain("API Type");
		screen.handleInput("\x1b"); // back to the left column
		screen.handleInput("\x1b[B"); // Built-in models
		screen.handleInput("\r");
		screen.handleInput("v4-pro");
		screen.handleInput("\r"); // opens the model's page over the list
		expect(render(screen)).toContain("Built-in models / DeepSeek V4 Pro");
		expect(render(screen)).toContain("Reset to built-in · nothing overridden");
		expect(render(screen)).not.toMatch(modelRow); // an untouched catalog model has no left row
		for (let index = 0; index < 6; index++) screen.handleInput("\x1b[B"); // maxTokens
		screen.handleInput("\x1b[200~4096\x1b[201~");
		screen.handleInput("\r");
		expect(render(screen)).toContain("maxTokens: 4096 · overridden");
		await store.flush();
		expect(store.getProvider("deepseek")).toEqual({ modelOverrides: { "deepseek-v4-pro": { maxTokens: 4096 } } });
		screen.syncFromStore();
		// The override earns a left row; the page stays open where it was.
		expect(render(screen)).toMatch(modelRow);
		expect(render(screen)).toContain("Built-in models / DeepSeek V4 Pro");
		expect(render(screen)).toContain("Reset to built-in · 1 overridden");
		for (let index = 0; index < 3; index++) screen.handleInput("\x1b[B"); // Reset to built-in
		screen.handleInput("\r");
		screen.handleInput("\x1b[A"); // Reset to built-in
		screen.handleInput("\r");
		await store.flush();
		expect(JSON.parse(readFileSync(store.path, "utf8")).providers.deepseek).toBeUndefined();
		screen.syncFromStore();
		expect(render(screen)).toContain("Reset to built-in · nothing overridden");
		expect(render(screen)).not.toMatch(modelRow);
		screen.handleInput("\x1b"); // back to the Built-in models list, search kept
		expect(render(screen)).toMatch(/1 of 2 built-in models/);
		screen.dispose();
	});

	test("an overridden built-in model opens from its own left row", async () => {
		store.setProviderField("deepseek", ["modelOverrides", "deepseek-v4-pro", "maxTokens"], 4096);
		await store.flush();
		const { screen } = editor("deepseek");
		screen.handleInput("\x1b[B"); // the override's row, ahead of Built-in models
		const page = render(screen);
		expect(page).toMatch(/›\s*DeepSeek V4 Pro/);
		expect(page).toContain("maxTokens: 4096 · overridden");
		expect(page).not.toContain("Built-in models / ");
		screen.dispose();
	});
});

describe("connection notes and errors", () => {
	const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

	test("an apiKey typed here hides a stale environment-key note", async () => {
		const runtime = runtimeStub();
		runtime.getProviderAuthStatus = () => ({ configured: true, source: "environment", label: "CPA_API_KEY" });
		const { screen } = editor("cpa", runtime);
		screen.handleInput("\x1b[C");
		expect(render(screen)).toContain("The key currently comes from env CPA_API_KEY.");
		screen.handleInput("\x1b[B"); // apiKey
		screen.handleInput(paste("$OTHER_KEY"));
		screen.handleInput("\r");
		expect(render(screen)).not.toContain("currently comes from env");
		screen.dispose();
	});

	test("long errors wrap instead of being cut", () => {
		const message = `HTTP 401 from https://example.test/v1/models: ${"invalid key ".repeat(8)}(code=bad_key)`;
		const lines = renderErrorLines(theme, message, 40).map(stripAnsi);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join(" ")).toContain("HTTP 401");
		expect(lines.length).toBeLessThanOrEqual(4);
	});
});

describe("advanced fields", () => {
	const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
	const down = (screen: ProviderEditorScreen, count: number) => {
		for (let index = 0; index < count; index++) screen.handleInput("\x1b[B");
	};
	const diskProvider = (id: string) => JSON.parse(readFileSync(store.path, "utf8")).providers[id];

	test("advanced values are schema-checked JSON", () => {
		const field = (key: string) => MODEL_ADVANCED_FIELDS.find((entry) => entry.path.join(".") === key)!;
		expect(parseAdvancedValue(field("headers"), '{"X-Title":"pi"}')).toEqual({ value: { "X-Title": "pi" } });
		expect(parseAdvancedValue(field("headers"), "{x}")).toMatchObject({
			error: expect.stringContaining("not valid JSON"),
		});
		expect(parseAdvancedValue(field("headers"), '{"X-Count":1}')).toMatchObject({
			error: expect.stringContaining("headers.X-Count"),
		});
		expect(parseAdvancedValue(field("promptCache"), '{"short":-1}')).toMatchObject({
			error: expect.stringContaining("promptCache.short"),
		});
		expect(parseAdvancedValue(field("cost.tiers"), "[]")).toEqual({ value: [] });
	});

	test("a provider's advanced page edits name, headers, authHeader, and provider compat", async () => {
		const { screen } = editor();
		screen.handleInput("\x1b[C");
		down(screen, 3); // Advanced
		expect(render(screen)).toContain("Advanced · none set");
		screen.handleInput("\r");
		expect(render(screen)).toContain("Authentication / Advanced");
		screen.handleInput(paste("CPA Proxy"));
		screen.handleInput("\r");
		screen.handleInput("\x1b[B"); // headers
		screen.handleInput(paste('{"X-Title":1}'));
		screen.handleInput("\r");
		expect(render(screen)).toContain("headers.X-Title");
		screen.handleInput("\x1b"); // the editor stays open on errors; cancel it
		screen.handleInput(paste('{"X-Title":"pi"}'));
		screen.handleInput("\r");
		screen.handleInput("\x1b[B"); // authHeader
		screen.handleInput(" ");
		screen.handleInput("\x1b[B"); // compat
		screen.handleInput("\r");
		expect(render(screen)).toContain("Authentication / compat");
		await store.flush();
		expect(diskProvider("cpa")).toMatchObject({ name: "CPA Proxy", headers: { "X-Title": "pi" }, authHeader: true });
		screen.handleInput("\x1b");
		screen.handleInput("\x1b");
		expect(render(screen)).toContain("Advanced · set: name, headers, authHeader");
		screen.dispose();
	});

	test("token counts accept k and m suffixes and digit separators", () => {
		expect(parseTokenCount("500k")).toBe(500_000);
		expect(parseTokenCount("1.5M")).toBe(1_500_000);
		expect(parseTokenCount("500,000")).toBe(500_000);
		expect(parseTokenCount("272000")).toBe(272_000);
		for (const bad of ["0", "0.5", "abc", "-1", "1.5"]) expect(parseTokenCount(bad)).toBeUndefined();
	});

	test("thinkingLevelMap offers Custom, Default and Hidden per level; Custom edits inline", () => {
		const { host, model } = hostFixture();
		const pane = new ThinkingMapPane(host, model);
		const map = () => model.read().thinkingLevelMap;
		pane.handleInput("\r"); // off
		let screen = render(pane);
		expect(screen).toMatch(/○ Custom: type a provider effort\n.*● Default · key omitted.*\n.*○ Hidden/);
		expect(pane.hints()).toContain("set");
		pane.handleInput("\x1b[A"); // Custom
		expect(pane.hints()).toContain("edit");
		pane.handleInput("l"); // typing starts the inline edit at once, no submenu
		expect(pane.isEditing()).toBe(true);
		pane.handleInput("ow");
		pane.handleInput("\r");
		expect(map()).toEqual({ off: "low" });
		expect(render(pane)).toContain("off: low");
		pane.handleInput("\r");
		expect(render(pane)).toContain("● Custom: low");
		pane.handleInput("\r"); // Enter tweaks the current effort
		expect(pane.isEditing()).toBe(true);
		pane.handleInput("\x1b"); // cancelling keeps the choices open
		expect(render(pane)).toContain("● Custom: low");
		pane.handleInput("\x1b[B");
		pane.handleInput("\x1b[B"); // Hidden
		pane.handleInput("\r");
		expect(map()).toEqual({ off: null });
		screen = render(pane);
		expect(screen).toContain("off: Hidden");
		pane.handleInput("\r");
		pane.handleInput("\x1b[A"); // Default
		pane.handleInput("\r");
		expect(map()?.off).toBeUndefined();
	});

	test("thinkingLevelMap on a built-in model names the catalog value that Default restores", async () => {
		const { host } = hostFixture();
		const edits = new ProviderEdits(store, "openai", new RefreshCoordinator(runtimeStub()), vi.fn());
		const model = edits.override("gpt-6-astra");
		const pane = new ThinkingMapPane(host, model);
		expect(render(pane)).toContain("off: Hidden");
		pane.handleInput("\x1b[B");
		pane.handleInput("\x1b[B"); // low
		pane.handleInput("\r");
		expect(render(pane)).toContain("● Default · built-in: low");
		pane.handleInput("\x1b[B"); // Hidden
		pane.handleInput("\r");
		expect(model.own().thinkingLevelMap).toEqual({ low: null });
		pane.setFocused(true);
		expect(render(pane)).toContain("› low: Hidden · overridden"); // the cursor stays on the level just set
		pane.handleInput("\r");
		expect(render(pane)).toContain("Default · built-in: low, removes the override");
		pane.handleInput("\x1b[A");
		pane.handleInput("\x1b[A"); // Custom
		pane.handleInput("max");
		pane.handleInput("\r");
		expect(render(pane)).toContain("› low: max · overridden");
		pane.handleInput("\r");
		pane.handleInput("\x1b[B"); // Default
		pane.handleInput("\r");
		await store.flush();
		expect(diskProvider("openai")).toBeUndefined();
		pane.handleInput("\r");
		pane.handleInput("\x1b[A"); // Custom
		pane.handleInput("\r"); // tweaking starts from the catalog effort
		expect(pane.isEditing()).toBe(true);
		expect(render(pane)).toMatch(/○ Custom: low\S*_pi:c/);
	});

	test("a built-in model's cost page marks overridden rates and clears them back to the catalog", async () => {
		const { host } = hostFixture();
		const edits = new ProviderEdits(store, "openai", new RefreshCoordinator(runtimeStub()), vi.fn());
		const model = edits.override("gpt-6-astra");
		const pane = new CostPane(host, model);
		pane.setFocused(true);
		expect(render(pane)).toContain("› input: $10 / M tokens");
		expect(render(pane)).toContain("Dim rates are built in");
		expect(render(pane)).not.toContain("overridden");
		pane.handleInput("\x1b[B"); // output
		pane.handleInput("40");
		pane.handleInput("\r");
		expect(model.own().cost).toEqual({ output: 40 });
		expect(render(pane)).toContain("› output: $40 / M tokens · overridden");
		pane.handleInput("\r"); // tweak, then clear
		pane.handleInput("\x15");
		pane.handleInput("\r");
		expect(render(pane)).toContain("› output: $50 / M tokens");
		await store.flush();
		expect(diskProvider("openai")).toBeUndefined();
	});

	test("the cost row lists the four rates inline and nothing else", () => {
		store.ensureProviderView("openai");
		const { screen } = editor("openai");
		screen.handleInput("\x1b[B"); // Built-in models
		screen.handleInput("\r");
		screen.handleInput("astra");
		screen.handleInput("\r");
		expect(render(screen)).toMatch(/cost: 10 \/ 50 \/ 1 \/ 12\.5\s*$/m);
		screen.dispose();
		store.setModelField("cpa", "k3", ["cost"], { input: 0.3, output: 1.2 } as never);
		const { screen: custom } = editor("cpa");
		expect(render(custom)).not.toContain("1.2");
		custom.dispose();
	});

	test("a built-in model's advanced page writes overrides and clears them", async () => {
		store.ensureProviderView("deepseek");
		const { screen } = editor("deepseek");
		screen.handleInput("\x1b[B"); // Built-in models
		screen.handleInput("\r");
		screen.handleInput("v4-pro");
		screen.handleInput("\r");
		down(screen, 8); // Advanced
		screen.handleInput("\r");
		expect(render(screen)).toContain("Dim values are built in");
		screen.handleInput(paste('{"X-Trace":"1"}'));
		screen.handleInput("\r");
		expect(render(screen)).toContain('headers: {"X-Trace":"1"} · overridden');
		down(screen, 1); // samplingParams
		screen.handleInput(paste('{"top_k":20}'));
		screen.handleInput("\r");
		await store.flush();
		expect(diskProvider("deepseek")).toEqual({
			modelOverrides: { "deepseek-v4-pro": { headers: { "X-Trace": "1" }, samplingParams: { top_k: 20 } } },
		});
		screen.handleInput("\r"); // tweak, then clear
		screen.handleInput("\x15");
		screen.handleInput("\r");
		screen.handleInput("\x1b[A");
		screen.handleInput("\r");
		screen.handleInput("\x15");
		screen.handleInput("\r");
		await store.flush();
		expect(diskProvider("deepseek")).toBeUndefined();
		screen.dispose();
	});
});
