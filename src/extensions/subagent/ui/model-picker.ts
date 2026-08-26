import type { Api, Model } from "@earendil-works/pi-ai";
import { Container, type Focusable, type KeybindingsManager, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { AGENT_PROFILE_LABELS } from "../agents.ts";
import type { SubagentAgentName } from "../constants.ts";
import { truncate } from "../text.ts";
import type { AgentProfile } from "../types.ts";
import { hint, navigationHint } from "./choice-menu.ts";
import { type ProfileModelChoice, ProfileModelListComponent } from "./model-list.ts";

const MODEL_REFRESH_TIMEOUT_MS = 15_000;
const MAX_REFRESH_ERROR_LENGTH = 240;

function refreshFailureMessage(providerIds: readonly string[]): string {
	if (providerIds.length === 1) return `Could not refresh ${providerIds[0]}; showing cached models.`;
	const visible = providerIds.slice(0, 3);
	const omitted = providerIds.length - visible.length;
	const suffix = omitted > 0 ? `, +${omitted} more` : "";
	return `Could not refresh ${providerIds.length} model catalogs (${visible.join(", ")}${suffix}); showing cached models.`;
}

/** Searchable model page for one profile; confirm saves immediately. */
export class ModelPickerComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly title: string;
	private readonly hasScopedModels: boolean;
	private readonly titleText: Text;
	private readonly hintText: Text;
	private readonly modelList: ProfileModelListComponent;
	private readonly refreshAbortController = new AbortController();
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.modelList.focused = value;
	}

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		profile: AgentProfile;
		savedModelId: string | undefined;
		models: readonly Model<Api>[];
		scopedModels: readonly { model: Model<Api> }[];
		currentSessionModel: Model<Api> | undefined;
		onDone: (choice: ProfileModelChoice | undefined) => void;
	}) {
		super();
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.title = `Model — ${AGENT_PROFILE_LABELS[options.profile.name as SubagentAgentName]}`;
		this.hasScopedModels = options.scopedModels.length > 0;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.modelList = new ProfileModelListComponent({
			theme: options.theme,
			keybindings: options.keybindings,
			models: options.models,
			scopedModels: options.scopedModels,
			currentSessionModel: options.currentSessionModel,
			savedModelId: options.savedModelId,
			onDone: options.onDone,
		});
		this.addChild(this.modelList);
		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateStaticText();
	}

	private updateStaticText(): void {
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(this.title)));
		const hints = [
			navigationHint(this.theme, this.keybindings),
			this.hasScopedModels ? hint(this.theme, this.keybindings, "tui.input.tab", "scope") : "",
			hint(this.theme, this.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, this.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.hintText.setText(hints.join(this.theme.fg("muted", " • ")));
	}

	get refreshSignal(): AbortSignal {
		return this.refreshAbortController.signal;
	}

	cancelRefresh(): void {
		this.refreshAbortController.abort();
	}

	get isClosed(): boolean {
		return this.closed;
	}

	dispose(): void {
		this.closed = true;
		this.refreshAbortController.abort();
	}

	updateModels(models: readonly Model<Api>[]): void {
		if (this.closed) return;
		this.modelList.updateModels(models);
		this.tui.requestRender();
	}

	setRefreshStatus(message: string | undefined, tone: "muted" | "success" | "error" = "muted"): void {
		if (this.closed) return;
		this.modelList.setStatus(message, tone);
		this.tui.requestRender();
	}

	override invalidate(): void {
		this.updateStaticText();
		super.invalidate();
	}

	handleInput(data: string): void {
		this.modelList.handleInput(data);
	}
}

/** Triggers a background model-catalog refresh and updates the picker with results. */
export async function refreshPickerModels(ctx: ExtensionCommandContext, picker: ModelPickerComponent): Promise<void> {
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		picker.cancelRefresh();
	}, MODEL_REFRESH_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const result = await ctx.modelRegistry.refresh({ signal: picker.refreshSignal });
		if (picker.isClosed || (picker.refreshSignal.aborted && !timedOut)) return;
		picker.updateModels(ctx.modelRegistry.getAvailable());
		if (result.aborted && timedOut) {
			picker.setRefreshStatus("Model refresh timed out; showing cached models.", "error");
			return;
		}
		const providerIds = [...result.errors.keys()];
		if (providerIds.length > 0) {
			picker.setRefreshStatus(refreshFailureMessage(providerIds), "error");
			return;
		}
		const registryError = ctx.modelRegistry.getError?.();
		if (registryError) {
			picker.setRefreshStatus(truncate(registryError, MAX_REFRESH_ERROR_LENGTH), "error");
			return;
		}
		picker.setRefreshStatus(undefined);
	} catch (error) {
		if (picker.isClosed || (picker.refreshSignal.aborted && !timedOut)) return;
		const message = timedOut
			? "Model refresh timed out; showing cached models."
			: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
		picker.setRefreshStatus(truncate(message, MAX_REFRESH_ERROR_LENGTH), "error");
	} finally {
		clearTimeout(timeout);
	}
}
