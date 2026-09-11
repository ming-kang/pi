/**
 * provider — a minimalist visual editor for models.json.
 *
 * /provider edits the `providers` record of the runtime's models.json
 * directly (validated, lock-protected, atomic writes with a one-time .bak
 * backup per session) and refreshes the runtime offline when the session
 * closes. It never registers runtime providers and never stores a parallel
 * configuration. Adds two things over hand-editing the file: Fetch Models
 * (OpenAI-style GET {baseUrl}/models with Pi-resolved auth) and Use Built-in
 * Data (field-level completion from Pi's builtin model catalog).
 */

import type { Component } from "@earendil-works/pi-tui";
import { getModelsPath } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { COMMAND_DESCRIPTION, COMMAND_NAME, formatError, NO_MODELS_FILE_WARNING, NO_UI_WARNING } from "./constants.ts";
import { RefreshCoordinator } from "./refresh.ts";
import { ModelsJsonStore } from "./store.ts";
import { ProviderEditorScreen } from "./ui/editor.ts";
import { createProviderListScreen } from "./ui/provider-list.ts";
import { ProviderSessionClosedError, ProviderTuiSession } from "./ui/session.ts";

export default async function providerExtension(pi: ExtensionAPI): Promise<void> {
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: async (prefix) => {
			const trimmed = prefix.trim().toLowerCase();
			try {
				// Complete against the on-file providers; the file is small and reads are cheap.
				const load = await ModelsJsonStore.load(getModelsPath());
				if (!load.ok) return null;
				const items = load.store
					.getProviderIds()
					.filter((id) => !trimmed || id.toLowerCase().startsWith(trimmed))
					.map((id) => {
						const models = load.store.getProvider(id)?.models?.length ?? 0;
						return { value: id, label: id, description: `${models} model${models === 1 ? "" : "s"}` };
					});
				return items.length > 0 ? items : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			try {
				await runProviderCommand(args, ctx, pi);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

async function runProviderCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(NO_UI_WARNING, "warning");
		return;
	}
	const modelsPath = ctx.modelRuntime.getModelsPath();
	if (!modelsPath) {
		ctx.ui.notify(NO_MODELS_FILE_WARNING, "warning");
		return;
	}
	const load = await ModelsJsonStore.load(modelsPath);
	if (!load.ok) {
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			const session = new ProviderTuiSession(tui, theme, keybindings, done);
			void session.show(() => errorScreen(theme, load.error)).catch(() => {});
			return session;
		});
		return;
	}
	await runProviderTui(args, ctx, pi, load.store);
}

async function runProviderTui(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	store: ModelsJsonStore,
): Promise<void> {
	const refresher = new RefreshCoordinator(ctx.modelRuntime);
	let activeEditor: ProviderEditorScreen | undefined;
	let closedDuringTransition = false;
	let failure: { error: unknown } | undefined;

	store.onSaveResult = (result) => {
		if (result.kind === "conflict") activeEditor?.showConflicts(result.conflicts);
		else if (result.kind === "invalid") ctx.ui.notify(`models.json rejected the change:\n${result.error}`, "error");
		else if (result.kind === "error") ctx.ui.notify(result.error, "error");
		activeEditor?.syncFromStore();
	};

	const currentAtOpen = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;

	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const session = new ProviderTuiSession(tui, theme, keybindings, () => {
			closedDuringTransition = true;
			done();
		});
		const flow = async (): Promise<void> => {
			let pendingId = args.trim() || undefined;
			if (pendingId && !store.getProvider(pendingId)) {
				ctx.ui.notify(`No provider "${pendingId}" in models.json.`, "warning");
				pendingId = undefined;
			}
			while (true) {
				if (!pendingId) {
					const pick = await session.show(createProviderListScreen({ store }));
					if (pick.kind === "close") return;
					pendingId = pick.providerId;
				}
				const providerId = pendingId;
				pendingId = undefined;
				await session.show((editorTui, editorTheme, editorKeybindings, editorDone) => {
					activeEditor = new ProviderEditorScreen(editorTui, editorTheme, editorKeybindings, editorDone, {
						store,
						refresher,
						providerId,
						currentModel: currentAtOpen,
						registry: ctx.modelRegistry,
						runtime: ctx.modelRuntime,
						notify: (message, type) => ctx.ui.notify(message, type),
					});
					return activeEditor;
				});
				activeEditor = undefined;
			}
		};
		void flow().then(
			() => {
				if (!closedDuringTransition) finalize(done, ctx, pi, store, refresher, currentAtOpen);
			},
			(error: unknown) => {
				if (closedDuringTransition) {
					if (!(error instanceof ProviderSessionClosedError)) {
						try {
							ctx.ui.notify(formatError(error), "error");
						} catch {
							// The command context may have gone stale after the modal closed.
						}
					}
					return;
				}
				failure = { error };
				done();
			},
		);
		return session;
	});
	if (failure) throw failure.error;
}

/** Saves are already queued; wait for them, flush the runtime refresh, then re-sync the live model. */
function finalize(
	done: () => void,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	store: ModelsJsonStore,
	refresher: RefreshCoordinator,
	currentAtOpen: { provider: string; id: string } | undefined,
): void {
	void (async () => {
		try {
			await store.flush();
			const touched = refresher.touchedProviders;
			const outcome = await refresher.flush();
			if (!outcome.ok) {
				ctx.ui.notify(`models.json saved, but the runtime refresh failed: ${outcome.errors.join("; ")}`, "warning");
			}
			if (currentAtOpen && touched.includes(currentAtOpen.provider)) {
				const refreshed = ctx.modelRegistry.find(currentAtOpen.provider, currentAtOpen.id);
				if (refreshed) {
					const ok = await pi.setModel(refreshed);
					if (!ok) ctx.ui.notify("The current model's configuration changed; reselect it with /model.", "warning");
				} else {
					ctx.ui.notify("The current model was removed from models.json; pick another with /model.", "warning");
				}
			}
		} catch {
			// Best-effort finalization; individual failures were already reported.
		} finally {
			done();
		}
	})();
}

/** Read-only error page for a corrupt or schema-invalid models.json. */
function errorScreen(theme: Theme, error: string): Component & { dispose?(): void } {
	return new (class implements Component {
		private cached: { width: number; lines: string[] } | undefined;
		invalidate(): void {
			this.cached = undefined;
		}
		render(width: number): string[] {
			if (this.cached?.width === width) return this.cached.lines;
			const border = new DynamicBorder((text) => theme.fg("border", text)).render(width)[0]!;
			const lines = [
				border,
				theme.fg("error", " models.json is not editable in its current state:"),
				...error.split("\n").map((line) => theme.fg("muted", ` ${line}`)),
				"",
				theme.fg("dim", " Fix the file manually and run /provider again. The file is left untouched."),
				border,
			];
			this.cached = { width, lines };
			return lines;
		}
	})();
}
