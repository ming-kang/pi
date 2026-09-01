/**
 * /router interactive flows: list, add, edit, fetch, thinking map.
 *
 * Relay edits are live: confirmed inputs and every toggle persist immediately.
 * Searchable pickers follow Pi's native /model interaction pattern.
 */

import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { BorderedLoader } from "../../modes/interactive/components/bordered-loader.ts";
import { getModelSelectorSearchText } from "../../modes/interactive/model-search.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { formatError, isValidRelayId, NO_UI_WARNING, ROUTER_THINKING_LEVELS, truncate } from "./constants.ts";
import {
	createModelChecklist,
	createSearchableSelector,
	createThinkingMapEditor,
	type ModelChecklistItem,
} from "./dialog.ts";
import {
	createNativeRouterDialogs,
	type RouterDialogs,
	RouterTuiSession,
	RouterTuiSessionClosedError,
} from "./dialog-host.ts";
import {
	createDefaultModelConfig,
	displayModelLabel,
	resolveModelConfig,
	resolveRouterThinkingMap,
	summarizeThinkingMap,
} from "./presets.ts";
import { probeRelayModels } from "./probe.ts";
import { applyRouterFile, registerOneRelay, unregisterOneRelay } from "./register.ts";
import { loadRouterFile, removeRelay, upsertRelay } from "./store.ts";
import type { RelayConfig, RelayModelConfig } from "./types.ts";

/**
 * Serialize live relay mutations without forcing a model-registry refresh for
 * every checkbox press. Provider registration follows each snapshot; the
 * registry is refreshed once when the editor closes.
 */
class RelayAutoSaver {
	private chain: Promise<void> = Promise.resolve();
	private error: unknown;
	private needsRefresh = false;
	private readonly ctx: ExtensionCommandContext;
	private readonly pi: ExtensionAPI;
	private readonly relay: RelayConfig;

	constructor(ctx: ExtensionCommandContext, pi: ExtensionAPI, relay: RelayConfig) {
		this.ctx = ctx;
		this.pi = pi;
		this.relay = relay;
	}

	save(): void {
		const snapshot = structuredClone(this.relay);
		this.needsRefresh = true;
		this.chain = this.chain
			.catch(() => {})
			.then(async () => {
				await upsertRelay(snapshot);
				registerOneRelay(this.pi, snapshot);
				this.error = undefined;
			})
			.catch((error: unknown) => {
				this.error = error;
			});
	}

	async flush(): Promise<void> {
		await this.chain;
		if (this.error !== undefined) {
			const error = this.error;
			this.error = undefined;
			throw error;
		}
		if (this.needsRefresh) {
			this.needsRefresh = false;
			await this.ctx.modelRegistry.refresh();
		}
	}
}

/** Abort the catalog request if its internal page or the whole Router session is disposed. */
class RouterProbeLoader extends BorderedLoader {
	readonly probeSignal: AbortSignal;
	private readonly disposeController = new AbortController();

	constructor(tui: TUI, theme: Theme, message: string) {
		super(tui, theme, message, { cancellable: true });
		this.probeSignal = AbortSignal.any([this.signal, this.disposeController.signal]);
	}

	override dispose(): void {
		this.disposeController.abort();
		super.dispose();
	}
}

export function isCurrentRouterModel(
	current: { provider: string; id: string } | undefined,
	relayId: string,
	modelId: string,
): boolean {
	return current?.provider === relayId && current.id === modelId;
}

export async function runRouterCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(NO_UI_WARNING, "warning");
		return;
	}
	const trimmed = args.trim().toLowerCase();
	if (trimmed === "reload") {
		const file = await loadRouterFile();
		applyRouterFile(pi, file);
		await ctx.modelRegistry.refresh();
		ctx.ui.notify(`Reloaded ${file.relays.length} relay(s).`, "info");
		return;
	}
	if (ctx.mode === "tui") {
		await runRouterTuiCommand(args, ctx, pi);
		return;
	}
	await runRouterDialogCommand(args, ctx, pi, createNativeRouterDialogs(ctx));
}

async function runRouterTuiCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	let failure: { error: unknown } | undefined;
	let closedDuringTransition = false;
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const session = new RouterTuiSession(tui, theme, keybindings, () => {
			closedDuringTransition = true;
			done();
		});
		void runRouterDialogCommand(args, ctx, pi, session).then(
			() => {
				if (!closedDuringTransition) done();
			},
			(error: unknown) => {
				if (closedDuringTransition) {
					if (!(error instanceof RouterTuiSessionClosedError)) {
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

async function runRouterDialogCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
): Promise<void> {
	const trimmed = args.trim().toLowerCase();
	if (!trimmed || trimmed === "list") {
		await openMainMenu(ctx, pi, dialogs);
		return;
	}
	if (trimmed === "add") {
		await addRelayFlow(ctx, pi, dialogs);
		return;
	}
	// Treat as relay id open.
	const file = await loadRouterFile();
	const exact = file.relays.find((relay) => relay.id.toLowerCase() === trimmed);
	if (exact) {
		await editRelayFlow(ctx, pi, dialogs, exact);
		return;
	}
	await openMainMenu(ctx, pi, dialogs, args.trim());
}

async function openMainMenu(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
	initialQuery?: string,
): Promise<void> {
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
			dialogs.kind === "tui"
				? await dialogs.show(
						createSearchableSelector({
							title: "API relays",
							subtitle:
								file.relays.length === 0
									? "No relays yet — add a base URL + API key."
									: `${file.relays.length} relay${file.relays.length === 1 ? "" : "s"} · Enter opens · Esc closes`,
							items,
							initialValue: cursor,
							initialQuery: query,
							maxVisible: 10,
						}),
					)
				: await selectRouterItem(
						dialogs,
						"API relays",
						items.map((item) => ({ value: item.value, label: item.label, description: item.description })),
					);

		query = undefined;
		if (selected === undefined) return;
		cursor = selected;

		if (selected === "action:add") {
			const id = await addRelayFlow(ctx, pi, dialogs);
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
			await editRelayFlow(ctx, pi, dialogs, relay);
		}
	}
}

async function addRelayFlow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
): Promise<string | undefined> {
	const file = await loadRouterFile();
	const existing = new Set(file.relays.map((relay) => relay.id));

	const id = await promptText(ctx, dialogs, "New relay · name (provider id)", "my-relay", (value) => {
		const trimmed = value.trim();
		if (!trimmed) return "Name is required.";
		if (!isValidRelayId(trimmed)) return "Name cannot be empty or contain '/'.";
		if (existing.has(trimmed)) return `Relay "${trimmed}" already exists.`;
		return undefined;
	});
	if (id === undefined) return undefined;

	const baseUrl = await promptText(
		ctx,
		dialogs,
		`New relay · ${id.trim()} · base URL`,
		"https://relay.example/v1",
		(value) => {
			const trimmed = value.trim();
			if (!trimmed) return "Base URL is required.";
			try {
				const url = new URL(trimmed);
				if (url.protocol !== "http:" && url.protocol !== "https:") return "Use http or https.";
			} catch {
				return "Invalid URL.";
			}
			return undefined;
		},
	);
	if (baseUrl === undefined) return undefined;

	const apiKey = await promptText(
		ctx,
		dialogs,
		`New relay · ${id.trim()} · API key`,
		"sk-… or $RELAY_KEY",
		(value) => {
			if (!value.trim()) return "API key is required.";
			return undefined;
		},
	);
	if (apiKey === undefined) return undefined;

	const relay: RelayConfig = {
		id: id.trim(),
		baseUrl: baseUrl.trim().replace(/\/+$/, ""),
		apiKey: apiKey.trim(),
		models: [],
	};

	// Connection fields are committed before the network step so cancelling or
	// failing catalog discovery never loses the relay the user just entered.
	await persistRelay(ctx, pi, relay);
	await fetchAndSelectModels(ctx, pi, dialogs, relay);
	if (relay.models.length === 0) {
		ctx.ui.notify(`Relay "${relay.id}" has no models yet.`, "warning");
	}
	return relay.id;
}

/**
 * Relay editor — flat menu. Every mutation writes router.json immediately.
 * Hierarchy: list → relay → (models list | connection field | fetch | remove).
 */
async function editRelayFlow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
	initial: RelayConfig,
): Promise<void> {
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

		const choice = await selectRouterItem(dialogs, `Relay · ${relay.id}`, [
			{
				value: "models",
				label: "Models",
				description: modelSummary,
			},
			{ value: "baseUrl", label: "Base URL", description: relay.baseUrl },
			{ value: "apiKey", label: "API key", description: maskKey(relay.apiKey) },
			{ value: "remove", label: "Remove relay", description: "Delete from router.json" },
			{ value: "back", label: "Back", description: "Return to relays" },
		]);
		if (choice === undefined || choice === "back") return;

		if (choice === "baseUrl") {
			const next = await promptText(ctx, dialogs, `Relay · ${relay.id} · base URL`, relay.baseUrl, (value) => {
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
			await persistRelay(ctx, pi, relay);
			continue;
		}

		if (choice === "apiKey") {
			const next = await promptText(
				ctx,
				dialogs,
				`Relay · ${relay.id} · API key`,
				"Enter a new key · blank keeps the current value",
			);
			if (next === undefined) continue;
			const trimmed = next.trim();
			if (!trimmed || trimmed === relay.apiKey) continue;
			relay.apiKey = trimmed;
			await persistRelay(ctx, pi, relay);
			continue;
		}

		if (choice === "models") {
			// Always open the models screen (fetch lives only here). Empty list still
			// shows Fetch so the path is Relay → Models → Fetch, not a top-level shortcut.
			await manageModelsFlow(ctx, pi, dialogs, relay);
			continue;
		}

		if (choice === "remove") {
			if (ctx.model?.provider === relay.id) {
				ctx.ui.notify(`Switch away from relay "${relay.id}" before removing it.`, "warning");
				continue;
			}
			const ok = await dialogs.confirm(`Remove relay "${relay.id}"?`, "Models will disappear from /model.");
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
 * Models screen: searchable configured models plus fetch/manual-add actions.
 * Selecting a model opens its editor (name / thinking / remove).
 */
async function manageModelsFlow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
	relay: RelayConfig,
): Promise<void> {
	let cursor: string | undefined;
	while (true) {
		const items: Array<{ value: string; label: string; description?: string; searchText?: string }> = [
			...relay.models.map((model) => {
				const resolved = resolveModelConfig(model);
				const label = displayModelLabel(resolved);
				const thinking = summarizeThinkingMap(resolved.thinkingLevelMap);
				const current = ctx.model?.provider === relay.id && ctx.model.id === model.id ? " ✓" : "";
				return {
					value: `model:${model.id}`,
					label: `${model.id}${current}`,
					description: label !== model.id ? `${label} · ${thinking}` : thinking,
					searchText: `${getModelSelectorSearchText({ id: model.id, provider: relay.id, name: resolved.name })} ${thinking}`,
				};
			}),
			{
				value: "action:fetch",
				label: "Fetch catalog",
				description:
					relay.models.length === 0
						? "GET /models · select models"
						: "Refresh from server · keeps selected customizations",
				searchText: "fetch catalog refresh models server",
			},
			{
				value: "action:manual",
				label: "Add models manually",
				description: "Comma- or newline-separated model ids",
				searchText: "add manual custom model ids",
			},
			{ value: "action:back", label: "Back", description: "Return to relay", searchText: "back return" },
		];

		const currentValue = `model:${ctx.model?.id}`;
		const initialValue = cursor ?? (ctx.model?.provider === relay.id ? currentValue : undefined);
		const choice = await selectRouterItem(dialogs, `Relay · ${relay.id} · models`, items, { initialValue });
		if (choice === undefined || choice === "action:back") return;
		cursor = choice;

		if (choice === "action:fetch") {
			await fetchAndSelectModels(ctx, pi, dialogs, relay);
			continue;
		}

		if (choice === "action:manual") {
			const additions = await manualModelEntry(ctx, dialogs);
			if (!additions) continue;
			relay.models = mergeAddedModels(relay.models, additions);
			await persistRelay(ctx, pi, relay);
			continue;
		}

		if (choice.startsWith("model:")) {
			const modelId = choice.slice("model:".length);
			const model = relay.models.find((entry) => entry.id === modelId);
			if (!model) continue;
			await editModelFlow(ctx, pi, dialogs, relay, model);
		}
	}
}

/** Single-model editor: display name + thinking. Every confirmed change is live. */
async function editModelFlow(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
	relay: RelayConfig,
	model: RelayModelConfig,
): Promise<void> {
	while (true) {
		const resolved = resolveModelConfig(model);
		const nameDesc = resolved.name ? resolved.name : "(empty · /model shows id)";
		const action = await selectRouterItem(dialogs, `Relay · ${relay.id} · ${model.id}`, [
			{ value: "name", label: "Display name", description: nameDesc },
			{
				value: "thinking",
				label: "Thinking levels",
				description: summarizeThinkingMap(resolved.thinkingLevelMap),
			},
			{ value: "remove", label: "Remove model", description: "Delete this model from the relay" },
			{ value: "back", label: "Back", description: "Return to models" },
		]);
		if (action === undefined || action === "back") return;

		if (action === "name") {
			const next = await promptText(
				ctx,
				dialogs,
				`Display name · ${model.id} (empty = show id)`,
				resolved.name ?? "",
			);
			if (next === undefined) continue;
			const trimmed = next.trim();
			const nextName = !trimmed || trimmed === model.id ? undefined : trimmed;
			const prevName = model.name?.trim() && model.name.trim() !== model.id ? model.name.trim() : undefined;
			if (nextName === prevName) continue;
			if (nextName) model.name = nextName;
			else delete model.name;
			await persistRelay(ctx, pi, relay);
			continue;
		}

		if (action === "thinking") {
			const saver = new RelayAutoSaver(ctx, pi, relay);
			if (dialogs.kind === "tui") {
				await dialogs.show(
					createThinkingMapEditor({
						title: `Thinking · ${relay.id} / ${model.id}`,
						map: resolved.thinkingLevelMap,
						levels: ROUTER_THINKING_LEVELS,
						onChange: (nextMap) => {
							model.thinkingLevelMap = nextMap;
							model.reasoning = true;
							saver.save();
						},
					}),
				);
			} else {
				await editThinkingMapNative(dialogs, resolved.thinkingLevelMap, (nextMap) => {
					model.thinkingLevelMap = nextMap;
					model.reasoning = true;
					saver.save();
				});
			}
			await saver.flush();
			continue;
		}

		if (action === "remove") {
			if (isCurrentRouterModel(ctx.model, relay.id, model.id)) {
				ctx.ui.notify(`Switch away from model "${model.id}" before removing it.`, "warning");
				continue;
			}
			const ok = await dialogs.confirm(
				`Remove model "${model.id}"?`,
				"Its display name and thinking settings will be removed.",
			);
			if (!ok) continue;
			relay.models = relay.models.filter((entry) => entry.id !== model.id);
			await persistRelay(ctx, pi, relay);
			ctx.ui.notify(`Removed model "${model.id}".`, "info");
			return;
		}
	}
}

async function editThinkingMapNative(
	dialogs: RouterDialogs,
	map: RelayModelConfig["thinkingLevelMap"],
	onChange: (map: RelayModelConfig["thinkingLevelMap"]) => void,
): Promise<void> {
	let working = resolveRouterThinkingMap(map);
	while (true) {
		const choice = await selectRouterItem(dialogs, "Toggle thinking level", [
			...ROUTER_THINKING_LEVELS.map((level) => ({
				value: level,
				label: level,
				description:
					working[level] === null ? "hidden" : working[level] === undefined ? "default" : String(working[level]),
			})),
			{ value: "back", label: "Back", description: "Changes are live" },
		]);
		if (choice === undefined || choice === "back") return;
		if (!ROUTER_THINKING_LEVELS.includes(choice as (typeof ROUTER_THINKING_LEVELS)[number])) continue;
		const level = choice as (typeof ROUTER_THINKING_LEVELS)[number];
		working = {
			...working,
			[level]: working[level] === null ? level : null,
			off: null,
			minimal: null,
		};
		onChange({ ...working });
	}
}

async function fetchAndSelectModels(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
	relay: RelayConfig,
): Promise<void> {
	const key = resolveProbeApiKey(relay.apiKey);
	if (key.error) {
		ctx.ui.notify(key.error, "warning");
		await recoverWithManualModels(ctx, pi, dialogs, relay);
		return;
	}

	let result: Awaited<ReturnType<typeof probeRelayModels>> | undefined;
	while (true) {
		const probeOptions = { baseUrl: relay.baseUrl, apiKey: key.value };
		if (dialogs.kind === "tui") {
			result = await dialogs.show<Awaited<ReturnType<typeof probeRelayModels>> | undefined>(
				(tui, theme, _kb, done) => {
					const loader = new RouterProbeLoader(tui, theme, `Fetching models · ${relay.id}`);
					let settled = false;
					const finish = (value: Awaited<ReturnType<typeof probeRelayModels>> | undefined) => {
						if (settled) return;
						settled = true;
						loader.dispose();
						done(value);
					};
					loader.onAbort = () => finish(undefined);
					void probeRelayModels({ ...probeOptions, signal: loader.probeSignal })
						.then(finish)
						.catch((error) => finish({ ok: false, error: formatError(error) }));
					return loader;
				},
			);
		} else {
			ctx.ui.notify(`Fetching models from ${relay.baseUrl}…`, "info");
			result = await probeRelayModels(probeOptions);
		}

		if (result === undefined) return;
		if (result.ok && result.models.length === 0) {
			ctx.ui.notify("Server returned an empty model list.", "warning");
			const recovery = await selectRouterItem(dialogs, `Catalog empty · ${relay.id}`, [
				{ value: "retry", label: "Retry", description: "Fetch /models again" },
				{ value: "manual", label: "Add models manually", description: "Enter model ids without a catalog" },
				{ value: "back", label: "Back", description: "Return to relay settings" },
			]);
			if (recovery === "retry") continue;
			if (recovery === "manual") await recoverWithManualModels(ctx, pi, dialogs, relay);
			return;
		}
		if (result.ok) break;

		ctx.ui.notify(`Fetch failed: ${result.error}`, "error");
		const recovery = await selectRouterItem(dialogs, `Catalog unavailable · ${relay.id}`, [
			{ value: "retry", label: "Retry", description: "Fetch /models again" },
			{ value: "manual", label: "Add models manually", description: "Enter model ids without a catalog" },
			{ value: "back", label: "Back", description: "Return to relay settings" },
		]);
		if (recovery === "retry") continue;
		if (recovery === "manual") await recoverWithManualModels(ctx, pi, dialogs, relay);
		return;
	}

	if (!result || !result.ok) return;
	if (result.truncated) ctx.ui.notify("Catalog truncated to 2,000 models.", "warning");

	const activeModelId = ctx.model?.provider === relay.id ? ctx.model.id : undefined;
	const catalog = mergeCatalogWithConfigured(relay.models, result.models, activeModelId);
	const initiallySelected = new Set(relay.models.map((model) => model.id));
	if (activeModelId) initiallySelected.add(activeModelId);
	const currentModelId = activeModelId;
	const protectedIds = currentModelId ? new Set([currentModelId]) : undefined;
	const preserved = new Map(relay.models.map((model) => [model.id, structuredClone(model)]));
	if (activeModelId && !preserved.has(activeModelId)) {
		preserved.set(activeModelId, createDefaultModelConfig(activeModelId));
	}
	const saver = new RelayAutoSaver(ctx, pi, relay);
	const applySelection = (selectedIds: string[]) => {
		if (currentModelId && !selectedIds.includes(currentModelId)) {
			ctx.ui.notify(`Switch away from model "${currentModelId}" before disabling it.`, "warning");
			return;
		}
		relay.models = selectedIds.map((id) => {
			const previous = preserved.get(id);
			if (previous) return structuredClone(previous);
			const next = createDefaultModelConfig(id);
			preserved.set(id, next);
			return structuredClone(next);
		});
		saver.save();
	};

	if (dialogs.kind === "tui") {
		const choice = await dialogs.show(
			createModelChecklist({
				title: `Select models · ${relay.id}`,
				subtitle: "Space toggles immediately · Enter/Esc returns",
				models: catalog,
				initiallySelected,
				protectedIds,
				onChange: applySelection,
				onProtectedToggle: (id) => ctx.ui.notify(`Switch away from model "${id}" before disabling it.`, "warning"),
			}),
		);
		if (choice.kind === "close") applySelectionIfChanged(relay, choice.selectedIds, applySelection);
	} else {
		const ok = await dialogs.confirm(
			`Import ${result.models.length} models?`,
			"Non-TUI mode imports the full catalog.",
		);
		if (ok) applySelection([...new Set([...initiallySelected, ...result.models.map((model) => model.id)])]);
	}
	await saver.flush();
	if (relay.models.length === 0) ctx.ui.notify(`No models enabled for "${relay.id}".`, "warning");
}

async function manualModelEntry(
	ctx: ExtensionCommandContext,
	dialogs: RouterDialogs,
): Promise<RelayModelConfig[] | undefined> {
	const value = await dialogs.input("Model IDs (comma-separated)", "gpt-5.6-sol, gpt-5.6-luna");
	if (value === undefined) return undefined;
	const ids = [
		...new Set(
			value
				.split(/[,\r\n]+/)
				.map((id) => id.trim())
				.filter(Boolean),
		),
	];
	if (ids.length === 0) {
		ctx.ui.notify("Enter at least one model id.", "warning");
		return undefined;
	}
	return ids.map((id) => createDefaultModelConfig(id));
}

async function recoverWithManualModels(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	dialogs: RouterDialogs,
	relay: RelayConfig,
): Promise<void> {
	const additions = await manualModelEntry(ctx, dialogs);
	if (!additions) return;
	relay.models = mergeAddedModels(relay.models, additions);
	await persistRelay(ctx, pi, relay);
}

function mergeAddedModels(previous: RelayModelConfig[], additions: RelayModelConfig[]): RelayModelConfig[] {
	const result = previous.map((model) => structuredClone(model));
	const ids = new Set(result.map((model) => model.id));
	for (const model of additions) {
		if (ids.has(model.id)) continue;
		ids.add(model.id);
		result.push(model);
	}
	return result;
}

export function mergeCatalogWithConfigured(
	configured: ReadonlyArray<RelayModelConfig>,
	catalog: ReadonlyArray<{ id: string; name?: string }>,
	activeModelId?: string,
): ModelChecklistItem[] {
	const items = new Map<string, ModelChecklistItem>();
	const configuredById = new Map(configured.map((model) => [model.id, model]));
	for (const model of catalog) {
		const previous = configuredById.get(model.id);
		items.set(model.id, {
			id: model.id,
			name: previous?.name ?? model.name,
		});
	}
	for (const model of configured) {
		if (!items.has(model.id)) {
			items.set(model.id, {
				id: model.id,
				name: model.name ?? model.id,
				unavailable: true,
			});
		}
	}
	if (activeModelId && !items.has(activeModelId)) {
		items.set(activeModelId, { id: activeModelId, name: activeModelId, unavailable: true });
	}
	return [...items.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function applySelectionIfChanged(
	relay: RelayConfig,
	selectedIds: ReadonlyArray<string>,
	apply: (ids: string[]) => void,
): void {
	const current = new Set(relay.models.map((model) => model.id));
	if (current.size === selectedIds.length && selectedIds.every((id) => current.has(id))) return;
	apply([...selectedIds]);
}

async function persistRelay(ctx: ExtensionCommandContext, pi: ExtensionAPI, relay: RelayConfig): Promise<void> {
	await upsertRelay(relay);
	registerOneRelay(pi, relay);
	await ctx.modelRegistry.refresh();
}

async function promptText(
	ctx: ExtensionCommandContext,
	dialogs: RouterDialogs,
	title: string,
	placeholder: string,
	validate?: (value: string) => string | undefined,
): Promise<string | undefined> {
	while (true) {
		const value = await dialogs.input(title, placeholder);
		if (value === undefined) return undefined;
		const error = validate?.(value);
		if (error) {
			ctx.ui.notify(error, "warning");
			continue;
		}
		return value;
	}
}

async function selectRouterItem<T extends string>(
	dialogs: RouterDialogs,
	title: string,
	items: ReadonlyArray<{ value: T; label: string; description?: string; searchText?: string }>,
	opts?: { initialValue?: T; initialQuery?: string; maxVisible?: number },
): Promise<T | undefined> {
	if (dialogs.kind === "tui") {
		return dialogs.show(
			createSearchableSelector({
				title,
				items,
				initialValue: opts?.initialValue,
				initialQuery: opts?.initialQuery,
				maxVisible: opts?.maxVisible ?? Math.min(10, Math.max(1, items.length)),
			}),
		);
	}
	const labels = items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label));
	const selected = await dialogs.select(title, labels);
	if (selected === undefined) return undefined;
	return items[labels.indexOf(selected)]?.value;
}

function maskKey(key: string): string {
	if (key.startsWith("$") || key.startsWith("!")) return key;
	if (key.length <= 8) return "••••";
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Resolve only keys that can be safely used by the catalog probe. */
export function resolveProbeApiKey(apiKey: string): { value?: string; error?: string } {
	const trimmed = apiKey.trim();
	if (!trimmed) return {};
	if (trimmed.startsWith("!")) {
		return { error: "This API key uses a !command and cannot be resolved for catalog probing." };
	}
	const envOnly = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
	const braced = trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
	const envName = envOnly?.[1] ?? braced?.[1];
	if (envName) {
		const value = process.env[envName]?.trim();
		return value ? { value } : { error: `Environment variable $${envName} is not set.` };
	}
	if (trimmed.includes("$")) {
		return { error: "This API key contains interpolation and cannot be resolved for catalog probing." };
	}
	return { value: trimmed };
}
