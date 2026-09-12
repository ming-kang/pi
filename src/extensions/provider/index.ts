/** /provider edits the current runtime's models.json through a native TUI. */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { COMMAND_DESCRIPTION, COMMAND_NAME, formatError, NO_MODELS_FILE_WARNING, NO_UI_WARNING } from "./constants.ts";
import { ModelsJsonStore } from "./store.ts";
import { createProviderApp, createProviderErrorScreen } from "./ui/app.ts";

export default function providerExtension(pi: ExtensionAPI): void {
	let modelsPath: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		modelsPath = ctx.modelRuntime.getModelsPath();
	});
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: async (prefix) => {
			if (!modelsPath) return null;
			const load = await ModelsJsonStore.load(modelsPath);
			if (!load.ok) return null;
			const query = prefix.trim().toLowerCase();
			const items = load.store
				.getProviderIds()
				.filter((id) => id.toLowerCase().startsWith(query))
				.map((id) => ({
					value: id,
					label: id,
					description: `${String(load.store.getModels(id).length)} model(s)`,
				}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(NO_UI_WARNING, "warning");
				return;
			}
			const path = ctx.modelRuntime.getModelsPath();
			modelsPath = path;
			if (!path) {
				ctx.ui.notify(NO_MODELS_FILE_WARNING, "warning");
				return;
			}
			try {
				const load = await ModelsJsonStore.load(path);
				if (!load.ok) {
					await ctx.ui.custom<void>((tui, _theme, _keybindings, done) =>
						createProviderErrorScreen(tui, done, load.error),
					);
					return;
				}
				await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
					createProviderApp(tui, theme, keybindings, done, {
						store: load.store,
						runtime: ctx.modelRuntime,
						registry: ctx.modelRegistry,
						getCurrentModel: () => ctx.model,
						setModel: (model) => pi.setModel(model),
						notify: (message, type) => ctx.ui.notify(message, type),
						initialProviderId: args.trim() || undefined,
					}),
				);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}
