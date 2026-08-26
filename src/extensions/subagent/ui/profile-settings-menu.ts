import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	type KeybindingsManager,
	Spacer,
	Text,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { AGENT_PROFILE_LABELS } from "../agents.ts";
import type { AgentProfile, SubagentProfileOverride } from "../types.ts";
import { hint, navigationHint } from "./choice-menu.ts";
import { buildSettingsRows, type SettingsAction, type SettingsRow } from "./choices.ts";

/** Compact Model/Thinking settings menu for one profile; every confirm persists immediately. */
export class ProfileSettingsMenuComponent extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly rows: readonly SettingsRow[];
	private readonly onDone: (action: SettingsAction | undefined) => void;
	private readonly title: string;
	private readonly status: string | undefined;
	private readonly titleText: Text;
	private readonly statusText: Text | undefined;
	private readonly hintText: Text;
	private readonly listContainer: Container;
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(options: {
		theme: Theme;
		keybindings: KeybindingsManager;
		profile: AgentProfile;
		override: SubagentProfileOverride | undefined;
		models: readonly Model<Api>[];
		currentSessionModel: Model<Api> | undefined;
		currentThinking: ThinkingLevel;
		selectedAction?: SettingsAction;
		status?: string;
		onDone: (action: SettingsAction | undefined) => void;
	}) {
		super();
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onDone = options.onDone;
		this.title = AGENT_PROFILE_LABELS[options.profile.name];
		this.status = options.status;
		this.rows = buildSettingsRows({
			override: options.override,
			models: options.models,
			currentSessionModel: options.currentSessionModel,
			currentThinking: options.currentThinking,
		}) satisfies SettingsRow[];
		this.selectedIndex = Math.max(
			0,
			this.rows.findIndex((row) => row.action === options.selectedAction),
		);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		if (this.status) {
			this.statusText = new Text("", 1, 0);
			this.addChild(this.statusText);
			this.addChild(new Spacer(1));
		} else {
			this.statusText = undefined;
		}
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateStaticText();
		this.updateList();
	}

	private updateStaticText(): void {
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(this.title)));
		this.statusText?.setText(this.theme.fg("muted", this.status ?? ""));
		const hints = [
			navigationHint(this.theme, this.keybindings),
			hint(this.theme, this.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, this.keybindings, "tui.select.cancel", "back"),
		].filter(Boolean);
		this.hintText.setText(hints.join(this.theme.fg("muted", " • ")));
	}

	private updateList(): void {
		this.listContainer.clear();
		for (const [index, row] of this.rows.entries()) {
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = selected ? this.theme.fg("accent", row.label) : this.theme.fg("text", row.label);
			const value = this.theme.fg("muted", `— ${row.value}`);
			const checkmark = row.override ? this.theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new TruncatedText(`${prefix}${label} ${value}${checkmark}`, 1, 0));
		}
	}

	private moveSelection(offset: -1 | 1): void {
		this.selectedIndex = (this.selectedIndex + offset + this.rows.length) % this.rows.length;
		this.updateList();
	}

	override invalidate(): void {
		this.updateStaticText();
		this.updateList();
		super.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.onDone(this.rows[this.selectedIndex]?.action);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(undefined);
		}
	}
}
