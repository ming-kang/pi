/**
 * /router interactive flows: list, add, edit, fetch, thinking map.
 *
 * Relay edits auto-save to router.json (no separate Save step). Nested multi-select
 * and thinking editors require Ctrl+S to apply, and warn on Esc when dirty.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { BorderedLoader } from "../../modes/interactive/components/bordered-loader.ts";
import { formatError, isValidRelayId, NO_UI_WARNING, truncate } from "./constants.ts";
import { createModelChecklist, createSearchableSelector, createThinkingMapEditor } from "./dialog.ts";
import { createDefaultModelConfig, displayModelLabel, resolveModelConfig, summarizeThinkingMap } from "./presets.ts";
import { probeRelayModels } from "./probe.ts";
import { applyRouterFile, registerOneRelay, unregisterOneRelay } from "./register.ts";
import { loadRouterFile, removeRelay, upsertRelay } from "./store.ts";
import type { RelayConfig, RelayModelConfig } from "./types.ts";

export async function runRouterCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(NO_UI_WARNING, "warning");
		return;
	}
	const trimmed = args.trim().toLowerCase();
	if (!trimmed || trimmed === "list") {
		await openMainMenu(ctx, pi);
		return;
	}
	if (trimmed === "add") {
		await addRelayFlow(ctx, pi);
		return;
	}
	if (trimmed === "reload") {
		const file = await loadRouterFile();
		applyRouterFile(pi, file);
		await ctx.modelRegistry.refresh();
		ctx.ui.notify(`Reloaded ${file.relays.length} relay(s).`, "info");
		return;
	}
	// Treat as relay id open
	const file = await loadRouterFile();
	const exact = file.relays.find((relay) => relay.id.toLowerCase() === trimmed);
	if (exact) {
		await editRelayFlow(ctx, pi, exact);
		return;
	}
	await openMainMenu(ctx, pi, args.trim());
}

async function openMainMenu(ctx: ExtensionCommandContext, pi: ExtensionAPI, initialQuery?: string): Promise<void> {
	let cursor: string | undefined;
	let query = initialQuery;
	while (true) {
		const file = await loadRouterFile();
		// Relays first (primary content), actions at the bottom.
		const items = [
			...file.relays.map((relay) => ({
				value: `relay:${relay.id}`,
				label: relay.id,
				description: `${relay.models.length} model${relay.models.length === 1 ? "" : "s"} · ${truncate(relay.baseUrl, 40)}`,
				searchText: `${relay.id} ${relay.baseUrl}`,
			})),
			{
				value: "action:add",
				label: "+ Add relay",
				description: "Name · base URL · API key · fetch models",
				searchText: "add create new relay gateway",
			},
			{
				value: "action:reload",
				label: "Reload from disk",
				description: "Re-register providers from router.json",
				searchText: "reload refresh",
			},
		];

		const selected =
			ctx.mode === "tui"
				? await ctx.ui.custom(
						createSearchableSelector({
							title: "API relays",
							subtitle:
								file.relays.length === 0
									? "No relays yet — add a base URL + API key."
									: `${file.relays.length} relay${file.relays.length === 1 ? "" : "s"} · Enter opens · Esc closes`,
							items,
							initialValue: cursor,
							initialQuery: query,
							maxVisible: 12,
						}),
					)
				: await selectNative(
						ctx,
						"API relays",
						items.map((item) => ({ value: item.value, label: item.label, description: item.description })),
					);

		query = undefined;
		if (selected === undefined) return;
		cursor = selected;

		if (selected === "action:add") {
			const id = await addRelayFlow(ctx, pi);
			if (id) cursor = `relay:${id}`;
			continue;
		}
		if (selected === "action:reload") {
			const latest = await loadRouterFile();
			applyRouterFile(pi, latest);
			await ctx.modelRegistry.refresh();
			ctx.ui.notify(`Reloaded ${latest.relays.length} relay(s).`, "info");
			continue;
		}
		if (selected.startsWith("relay:")) {
			const id = selected.slice("relay:".length);
			const latest = await loadRouterFile();
			const relay = latest.relays.find((entry) => entry.id === id);
			if (!relay) {
				ctx.ui.notify(`Relay "${id}" not found.`, "warning");
				continue;
			}
			await editRelayFlow(ctx, pi, relay);
		}
	}
}

async function addRelayFlow(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<string | undefined> {
	const file = await loadRouterFile();
	const existing = new Set(file.relays.map((relay) => relay.id));

	const id = await promptText(ctx, "New relay · name (provider id)", "my-relay", (value) => {
		const trimmed = value.trim();
		if (!trimmed) return "Name is required.";
		if (!isValidRelayId(trimmed)) return "Name cannot be empty or contain '/'.";
		if (existing.has(trimmed)) return `Relay "${trimmed}" already exists.`;
		return undefined;
	});
	if (id === undefined) return undefined;

	const baseUrl = await promptText(ctx, `New relay · ${id.trim()} · base URL`, "https://relay.example/v1", (value) => {
		const trimmed = value.trim();
		if (!trimmed) return "Base URL is required.";
		try {
			const url = new URL(trimmed);
			if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http or https.";
		} catch {
			return "Invalid URL.";
		}
		return undefined;
	});
	if (baseUrl === undefined) return undefined;

	const apiKey = await promptText(ctx, `New relay · ${id.trim()} · API key`, "sk-… or $RELAY_KEY", (value) => {
		if (!value.trim()) return "API key is required.";
		return undefined;
	});
	if (apiKey === undefined) return undefined;

	const relay: RelayConfig = {
		id: id.trim(),
		baseUrl: baseUrl.trim().replace(/\/+$/, ""),
		apiKey: apiKey.trim(),
		models: [],
	};

	const models = await fetchAndSelectModels(ctx, relay, new Set());
	if (models === undefined) {
		const keep = await ctx.ui.confirm(
			"Save relay without models?",
			"You can fetch models later from the relay editor. Changes auto-save after that.",
		);
		if (!keep) return undefined;
	} else {
		relay.models = models;
	}

	await persistRelay(ctx, pi, relay, {
		notify:
			relay.models.length > 0
				? `Saved "${relay.id}" with ${relay.models.length} model(s).`
				: `Saved "${relay.id}" (no models yet).`,
	});
	return relay.id;
}

/**
 * Relay editor — flat menu. Every mutation writes router.json immediately.
 * Hierarchy: list → relay → (models list | connection field | fetch | remove).
 */
async function editRelayFlow(ctx: ExtensionCommandContext, pi: ExtensionAPI, initial: RelayConfig): Promise<void> {
	const relay = structuredClone(initial);
	while (true) {
		const modelSummary =
			relay.models.length === 0
				? "none yet — fetch catalog"
				: relay.models.length <= 3
					? relay.models.map((m) => displayModelLabel(m)).join(", ")
					: `${relay.models.length} models · ${relay.models
							.slice(0, 2)
							.map((m) => displayModelLabel(m))
							.join(", ")}…`;

		const choice = await selectNative(ctx, `Relay · ${relay.id}`, [
			{
				value: "models",
				label: "Models",
				description: modelSummary,
			},
			{ value: "baseUrl", label: "Base URL", description: relay.baseUrl },
			{ value: "apiKey", label: "API key", description: maskKey(relay.apiKey) },
			{ value: "remove", label: "Remove relay", description: "Delete from router.json" },
			{ value: "back", label: "Back", description: "All edits already saved" },
		]);
		if (choice === undefined || choice === "back") return;

		if (choice === "baseUrl") {
			const next = await promptText(ctx, `Relay · ${relay.id} · base URL`, relay.baseUrl, (value) => {
				try {
					const url = new URL(value.trim());
					if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http or https.";
				} catch {
					return "Invalid URL.";
				}
				return undefined;
			});
			if (next === undefined) continue;
			const normalized = next.trim().replace(/\/+$/, "");
			if (normalized === relay.baseUrl) continue;
			relay.baseUrl = normalized;
			await persistRelay(ctx, pi, relay, { notify: `Saved base URL for "${relay.id}".` });
			continue;
		}

		if (choice === "apiKey") {
			const next = await promptText(ctx, `Relay · ${relay.id} · API key`, relay.apiKey, (value) =>
				value.trim() ? undefined : "API key is required.",
			);
			if (next === undefined) continue;
			const trimmed = next.trim();
			if (trimmed === relay.apiKey) continue;
			relay.apiKey = trimmed;
			await persistRelay(ctx, pi, relay, { notify: `Saved API key for "${relay.id}".` });
			continue;
		}

		if (choice === "models") {
			// Always open the models screen (fetch lives only here). Empty list still
			// shows Fetch so the path is Relay → Models → Fetch, not a top-level shortcut.
			await manageModelsFlow(ctx, pi, relay);
			continue;
		}

		if (choice === "remove") {
			const ok = await ctx.ui.confirm(`Remove relay "${relay.id}"?`, "Models will disappear from /model.");
			if (!ok) continue;
			await removeRelay(relay.id);
			unregisterOneRelay(pi, relay.id);
			await ctx.modelRegistry.refresh();
			ctx.ui.notify(`Removed relay "${relay.id}".`, "info");
			return;
		}
	}
}

/**
 * Models screen: flat list of configured models + fetch. Selecting a model opens
 * its editor (name / thinking). No extra "customize vs list" intermediate menu.
 */
async function manageModelsFlow(ctx: ExtensionCommandContext, pi: ExtensionAPI, relay: RelayConfig): Promise<void> {
	while (true) {
		const empty = relay.models.length === 0;
		const items: Array<{ value: string; label: string; description?: string }> = [
			{
				value: "action:fetch",
				label: "Fetch catalog",
				description: empty
					? "GET /models · multi-select · auto-saves"
					: "Refresh from server (keeps name/thinking for kept ids)",
			},
			...relay.models.map((model) => {
				const resolved = resolveModelConfig(model);
				const label = displayModelLabel(resolved);
				const thinking = summarizeThinkingMap(resolved.thinkingLevelMap);
				return {
					value: `model:${model.id}`,
					label: model.id,
					description: label !== model.id ? `${label} · ${thinking}` : thinking,
				};
			}),
			{ value: "action:back", label: "Back", description: "Return to relay" },
		];

		const choice = await selectNative(ctx, `Relay · ${relay.id} · models`, items);
		if (choice === undefined || choice === "action:back") return;

		if (choice === "action:fetch") {
			const selected = await fetchAndSelectModels(ctx, relay, new Set(relay.models.map((m) => m.id)));
			if (!selected) continue;
			relay.models = mergeModelSelection(relay.models, selected);
			await persistRelay(ctx, pi, relay, {
				notify: `Saved "${relay.id}" · ${relay.models.length} model(s).`,
			});
			continue;
		}

		if (choice.startsWith("model:")) {
			const modelId = choice.slice("model:".length);
			const model = relay.models.find((entry) => entry.id === modelId);
			if (!model) continue;
			await editModelFlow(ctx, pi, relay, model);
		}
	}
}

/** Single-model editor: display name + thinking. Auto-saves each applied change. */
async function editModelFlow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	relay: RelayConfig,
	model: RelayModelConfig,
): Promise<void> {
	while (true) {
		const resolved = resolveModelConfig(model);
		const nameDesc = resolved.name ? resolved.name : "(empty · /model shows id)";
		const action = await selectNative(ctx, `Relay · ${relay.id} · ${model.id}`, [
			{ value: "name", label: "Display name", description: nameDesc },
			{
				value: "thinking",
				label: "Thinking levels",
				description: summarizeThinkingMap(resolved.thinkingLevelMap),
			},
			{ value: "back", label: "Back", description: "Edits auto-save when applied" },
		]);
		if (action === undefined || action === "back") return;

		if (action === "name") {
			const next = await promptText(ctx, `Display name · ${model.id} (empty = show id)`, resolved.name ?? "");
			if (next === undefined) continue;
			const trimmed = next.trim();
			const nextName = !trimmed || trimmed === model.id ? undefined : trimmed;
			const prevName = model.name?.trim() && model.name.trim() !== model.id ? model.name.trim() : undefined;
			if (nextName === prevName) continue;
			if (nextName) model.name = nextName;
			else delete model.name;
			await persistRelay(ctx, pi, relay, {
				notify: model.name
					? `Saved display name "${model.name}" for ${model.id}.`
					: `Cleared display name for ${model.id}; /model shows id.`,
			});
			continue;
		}

		if (action === "thinking") {
			const nextMap =
				ctx.mode === "tui"
					? await ctx.ui.custom(
							createThinkingMapEditor({
								title: `Thinking · ${relay.id} / ${model.id}`,
								map: resolved.thinkingLevelMap,
							}),
						)
					: await editThinkingMapNative(ctx, resolved.thinkingLevelMap);
			if (!nextMap) continue;
			model.thinkingLevelMap = nextMap;
			model.reasoning = true;
			await persistRelay(ctx, pi, relay, {
				notify: `Saved thinking levels for ${model.id}.`,
			});
		}
	}
}

async function editThinkingMapNative(
	ctx: ExtensionCommandContext,
	map: RelayModelConfig["thinkingLevelMap"],
): Promise<RelayModelConfig["thinkingLevelMap"] | undefined> {
	const working = { ...(map ?? {}) };
	while (true) {
		const choice = await selectNative(ctx, "Toggle thinking level", [
			...(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => ({
				value: level,
				label: level,
				description:
					working[level] === null ? "hidden" : working[level] === undefined ? "default" : String(working[level]),
			})),
			{ value: "done", label: "Apply" },
			{ value: "cancel", label: "Cancel" },
		]);
		if (choice === undefined || choice === "cancel") return undefined;
		if (choice === "done") return working;
		if (working[choice] === null) working[choice] = choice === "off" ? "none" : choice;
		else working[choice] = null;
	}
}

async function fetchAndSelectModels(
	ctx: ExtensionCommandContext,
	relay: Pick<RelayConfig, "id" | "baseUrl" | "apiKey">,
	initiallySelected: ReadonlySet<string>,
): Promise<RelayModelConfig[] | undefined> {
	const probeOptions = {
		baseUrl: relay.baseUrl,
		apiKey: literalKey(relay.apiKey),
	};

	let result: Awaited<ReturnType<typeof probeRelayModels>> | undefined;
	if (ctx.mode === "tui") {
		result = await ctx.ui.custom<Awaited<ReturnType<typeof probeRelayModels>> | undefined>(
			(tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Fetching models · ${relay.id}`, {
					cancellable: true,
				});
				let settled = false;
				const finish = (value: Awaited<ReturnType<typeof probeRelayModels>> | undefined) => {
					if (settled) return;
					settled = true;
					loader.dispose();
					done(value);
				};
				loader.onAbort = () => finish(undefined);
				void probeRelayModels({ ...probeOptions, signal: loader.signal })
					.then(finish)
					.catch((error) => finish({ ok: false, error: formatError(error) }));
				return loader;
			},
		);
	} else {
		ctx.ui.notify(`Fetching models from ${relay.baseUrl}…`, "info");
		result = await probeRelayModels(probeOptions);
	}

	if (result === undefined) return undefined;
	if (!result.ok) {
		ctx.ui.notify(`Fetch failed: ${result.error}`, "error");
		const manual = await ctx.ui.confirm("Add model IDs manually?", "Comma-separated ids.");
		if (!manual) return undefined;
		return manualModelEntry(ctx);
	}
	if (result.models.length === 0) {
		ctx.ui.notify("Server returned an empty model list.", "warning");
		return manualModelEntry(ctx);
	}
	if (result.truncated) {
		ctx.ui.notify("Catalog truncated to 2,000 models.", "warning");
	}

	let selectedIds: string[];
	if (ctx.mode === "tui") {
		const choice = await ctx.ui.custom(
			createModelChecklist({
				title: `Select models · ${relay.id}`,
				subtitle: "Space toggle · Ctrl+S apply · Esc warns if unsaved",
				models: result.models,
				initiallySelected,
			}),
		);
		if (choice.kind === "cancel") return undefined;
		selectedIds = choice.selectedIds;
	} else {
		const ok = await ctx.ui.confirm(
			`Import ${result.models.length} models?`,
			"Non-TUI mode imports the full catalog. Prefer the terminal UI to multi-select.",
		);
		if (!ok) return undefined;
		selectedIds = result.models.map((model) => model.id);
	}

	if (selectedIds.length === 0) {
		ctx.ui.notify("No models selected.", "warning");
		return undefined;
	}

	// Do not import remote catalog names — leave name empty so /model shows the id
	// unless the user sets a custom display name later.
	return selectedIds.map((id) => createDefaultModelConfig(id));
}

async function manualModelEntry(ctx: ExtensionCommandContext): Promise<RelayModelConfig[] | undefined> {
	const value = await ctx.ui.input("Model IDs (comma-separated)", "gpt-5.6-sol, gpt-5.6-luna");
	if (value === undefined) return undefined;
	const ids = value
		.split(/[,\r\n]+/)
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length === 0) {
		ctx.ui.notify("Enter at least one model id.", "warning");
		return undefined;
	}
	return ids.map((id) => createDefaultModelConfig(id));
}

/** Keep prior customizations when re-selecting overlapping ids. */
function mergeModelSelection(previous: RelayModelConfig[], selected: RelayModelConfig[]): RelayModelConfig[] {
	const prior = new Map(previous.map((model) => [model.id, model]));
	return selected.map((model) => {
		const old = prior.get(model.id);
		if (!old) return model;
		const merged: RelayModelConfig = {
			...model,
			reasoning: old.reasoning ?? model.reasoning,
			input: old.input ?? model.input,
			contextWindow: old.contextWindow ?? model.contextWindow,
			maxTokens: old.maxTokens ?? model.maxTokens,
			thinkingLevelMap: old.thinkingLevelMap ?? model.thinkingLevelMap,
		};
		// Preserve a user-set display name; never invent one on re-fetch.
		if (old.name?.trim() && old.name.trim() !== old.id) merged.name = old.name.trim();
		else delete merged.name;
		return merged;
	});
}

async function persistRelay(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	relay: RelayConfig,
	opts?: { notify?: string },
): Promise<void> {
	await upsertRelay(relay);
	registerOneRelay(pi, relay);
	await ctx.modelRegistry.refresh();
	if (opts?.notify) ctx.ui.notify(opts.notify, "info");
}

async function promptText(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
	validate?: (value: string) => string | undefined,
): Promise<string | undefined> {
	while (true) {
		const value = await ctx.ui.input(title, placeholder);
		if (value === undefined) return undefined;
		const error = validate?.(value);
		if (error) {
			ctx.ui.notify(error, "warning");
			continue;
		}
		return value;
	}
}

async function selectNative<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	items: ReadonlyArray<{ value: T; label: string; description?: string }>,
): Promise<T | undefined> {
	if (ctx.mode === "tui") {
		return ctx.ui.custom(
			createSearchableSelector({
				title,
				items,
				maxVisible: Math.min(12, Math.max(1, items.length)),
			}),
		);
	}
	const labels = items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label));
	const selected = await ctx.ui.select(title, labels);
	if (selected === undefined) return undefined;
	return items[labels.indexOf(selected)]?.value;
}

function maskKey(key: string): string {
	if (key.startsWith("$") || key.startsWith("!")) return key;
	if (key.length <= 8) return "••••";
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Best-effort key for catalog fetch (full resolution still goes through Pi at request time). */
function literalKey(apiKey: string): string | undefined {
	const trimmed = apiKey.trim();
	if (!trimmed || trimmed.startsWith("!")) return undefined;
	const envOnly = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
	if (envOnly) return process.env[envOnly[1]!];
	const braced = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	if (braced) return process.env[braced[1]!];
	if (trimmed.includes("$")) return undefined;
	return trimmed;
}
