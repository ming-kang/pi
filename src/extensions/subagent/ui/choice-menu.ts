import {
	Container,
	type Focusable,
	type KeybindingsManager,
	Spacer,
	Text,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyLabel } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

export interface MenuChoice<T> {
	label: string;
	value: T;
}

export function hint(
	theme: Theme,
	keybindings: KeybindingsManager,
	binding: Parameters<KeybindingsManager["getKeys"]>[0],
	description: string,
): string {
	const key = keyLabel(binding, { keybindings });
	return key ? `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}` : "";
}

export function navigationHint(theme: Theme, keybindings: KeybindingsManager): string {
	const keys = [keyLabel("tui.select.up", { keybindings }), keyLabel("tui.select.down", { keybindings })]
		.filter(Boolean)
		.join("/");
	return keys ? `${theme.fg("dim", keys)}${theme.fg("muted", " navigate")}` : "";
}

/** Small Pi-native list page used inside the single /agents custom UI lifecycle. */
export class ChoiceMenuComponent<T> extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly choices: readonly MenuChoice<T>[];
	private readonly onDone: (choice: MenuChoice<T> | undefined) => void;
	private readonly title: string;
	private readonly cancelDescription: "back" | "close";
	private readonly titleText: Text;
	private readonly hintText: Text;
	private readonly listContainer: Container;
	private selectedIndex: number;
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
		title: string;
		choices: readonly MenuChoice<T>[];
		onDone: (choice: MenuChoice<T> | undefined) => void;
		initialIndex?: number;
		cancelDescription: "back" | "close";
	}) {
		super();
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.choices = options.choices;
		this.onDone = options.onDone;
		this.title = options.title;
		this.cancelDescription = options.cancelDescription;
		this.selectedIndex = Math.min(Math.max(options.initialIndex ?? 0, 0), Math.max(0, options.choices.length - 1));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateStaticText();
		this.updateList();
	}

	private updateStaticText(): void {
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(this.title)));
		const hints = [
			navigationHint(this.theme, this.keybindings),
			hint(this.theme, this.keybindings, "tui.select.confirm", "select"),
			hint(this.theme, this.keybindings, "tui.select.cancel", this.cancelDescription),
		].filter(Boolean);
		this.hintText.setText(hints.join(this.theme.fg("muted", " • ")));
	}

	private updateList(): void {
		this.listContainer.clear();
		for (const [index, choice] of this.choices.entries()) {
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = this.theme.fg(selected ? "accent" : "text", choice.label);
			this.listContainer.addChild(new TruncatedText(`${prefix}${label}`, 1, 0));
		}
	}

	private moveSelection(offset: -1 | 1): void {
		if (this.choices.length === 0) return;
		this.selectedIndex = (this.selectedIndex + offset + this.choices.length) % this.choices.length;
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
			const choice = this.choices[this.selectedIndex];
			if (choice) this.onDone(choice);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(undefined);
		}
	}
}
