/** Provider navigation and save/refresh finalization in one modal lifetime. */

import type { Api, Model } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { ExtensionSelectorComponent } from "../../../modes/interactive/components/extension-selector.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { formatError, truncate } from "../constants.ts";
import { RefreshCoordinator } from "../refresh.ts";
import type { ModelsJsonStore } from "../store.ts";
import { ProviderEditorScreen } from "./editor.ts";
import { ProviderListScreen } from "./provider-list.ts";
import { ProviderTuiSession } from "./session.ts";

export interface ProviderAppOptions {
	store: ModelsJsonStore;
	runtime: Pick<ModelRuntime, "refresh" | "getError" | "getAuth" | "getProviderAuthStatus">;
	registry: Pick<ModelRegistry, "find" | "getProviderAuthStatus">;
	getCurrentModel(): { provider: string; id: string } | undefined;
	setModel(model: Model<Api>): Promise<boolean>;
	notify(message: string, type: "info" | "warning" | "error"): void;
	initialProviderId?: string;
}

class SavingScreen extends Container {
	private readonly keybindings: KeybindingsManager;
	private readonly onCancel: () => void;

	constructor(theme: Theme, keybindings: KeybindingsManager, onCancel: () => void) {
		super();
		this.keybindings = keybindings;
		this.onCancel = onCancel;
		this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		this.addChild(new Text(theme.fg("muted", "Saving provider changes and updating models…"), 1, 1));
		this.addChild(new Text(keyHint("tui.select.cancel", "return to providers"), 1, 0));
		this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) this.onCancel();
	}
}

export function createProviderErrorScreen(tui: TUI, done: () => void, error: string): ExtensionSelectorComponent {
	return new ExtensionSelectorComponent("models.json cannot be edited", ["Back"], done, done, {
		tui,
		subtitle: `${truncate(error, 2400)}\n\nFix the file manually and open /provider again.`,
	});
}

export function createProviderApp(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: () => void,
	options: ProviderAppOptions,
): ProviderTuiSession {
	const { store, registry, runtime } = options;
	const session = new ProviderTuiSession(tui);
	const refresher = new RefreshCoordinator(runtime);
	let activeEditor: ProviderEditorScreen | undefined;
	let closing: AbortController | undefined;

	function notify(message: string, type: "info" | "warning" | "error"): void {
		if (!session.signal.aborted) options.notify(message, type);
	}

	store.onSaveResult = (result) => {
		if (session.signal.aborted) return;
		if (result.kind === "invalid" || result.kind === "error") notify(result.error, "error");
		activeEditor?.syncFromStore();
		tui.requestRender();
	};

	function showList(): void {
		if (session.signal.aborted) return;
		activeEditor = undefined;
		session.setScreen(
			new ProviderListScreen(
				tui,
				theme,
				keybindings,
				(result) => {
					if (result.kind === "close") requestClose();
					else openProvider(result.providerId);
				},
				store,
			),
		);
	}

	function openProvider(providerId: string): void {
		if (!store.getProviderIds().includes(providerId)) {
			notify(`No provider ${JSON.stringify(providerId)} in models.json.`, "warning");
			showList();
			return;
		}
		activeEditor = new ProviderEditorScreen(tui, theme, keybindings, showList, {
			store,
			refresher,
			providerId,
			registry,
			runtime,
			currentModel: options.getCurrentModel(),
			notify,
		});
		session.setScreen(activeEditor);
	}

	function showUnsaved(error: string): void {
		const back = "Return to providers";
		const retry = "Retry saving";
		const discard = "Discard unsaved changes and close";
		session.setScreen(
			new ExtensionSelectorComponent(
				"Some changes are not saved",
				[back, retry, discard],
				(choice) => {
					if (choice === back) {
						showList();
						return;
					}
					if (choice === retry) store.retrySave();
					if (choice === discard) store.discardPending();
					requestClose();
				},
				showList,
				{ tui, subtitle: truncate(error, 2400) },
			),
		);
	}

	function requestClose(): void {
		if (closing || session.signal.aborted) return;
		const controller = new AbortController();
		closing = controller;
		const signal = AbortSignal.any([session.signal, controller.signal]);
		activeEditor = undefined;
		session.setScreen(
			new SavingScreen(theme, keybindings, () => {
				controller.abort();
				closing = undefined;
				showList();
			}),
		);
		void finishClose(controller, signal);
	}

	async function finishClose(controller: AbortController, signal: AbortSignal): Promise<void> {
		try {
			await store.flush();
			if (signal.aborted) return;
			const unsaved = store.getPendingError();
			if (unsaved) {
				closing = undefined;
				showUnsaved(unsaved);
				return;
			}
			const outcome = await refresher.flush(signal);
			if (signal.aborted) return;
			if (!outcome.ok) notify(`Changes saved, but model refresh failed: ${outcome.errors.join("; ")}`, "warning");
			const current = options.getCurrentModel();
			if (current && refresher.touchedProviders.includes(current.provider)) {
				const refreshed = registry.find(current.provider, current.id);
				if (refreshed && !(await options.setModel(refreshed))) {
					notify("Reselect the current model with /model to apply its updated configuration.", "warning");
				}
				if (!refreshed) notify("The current model is no longer available; select another with /model.", "warning");
			}
			if (!signal.aborted) done();
		} catch (error) {
			if (!signal.aborted) {
				notify(formatError(error), "error");
				showList();
			}
		} finally {
			if (closing === controller) closing = undefined;
		}
	}

	if (options.initialProviderId) openProvider(options.initialProviderId);
	else showList();
	return session;
}
