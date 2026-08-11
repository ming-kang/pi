import {
	Container,
	type Focusable,
	Input,
	type KeybindingsManager,
	Spacer,
	Text,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyLabel } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { displayAgentDescription, displayAgentName } from "../display-name.ts";
import type { AgentDefinition, AgentDiagnostic } from "../types.ts";

const MAX_VISIBLE_PROFILES = 10;

interface ProfileItem {
	kind: "profile";
	agent: AgentDefinition;
}

interface DiagnosticItem {
	kind: "diagnostics";
	count: number;
}

type PickerItem = ProfileItem | DiagnosticItem;

export type ProfilePickerResult = { kind: "profile"; name: string } | { kind: "diagnostics" } | undefined;

function compareProfileNames(left: AgentDefinition, right: AgentDefinition): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function hint(
	theme: Theme,
	keybindings: KeybindingsManager,
	binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
	description: string,
): string {
	const key = keyLabel(binding, { keybindings });
	return key ? `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}` : "";
}

/** Searchable, alphabetized profile selector used by /agents. */
export class ProfilePickerComponent extends Container implements Focusable {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly profiles: AgentDefinition[];
	private readonly diagnostics: readonly AgentDiagnostic[];
	private readonly onDone: (result: ProfilePickerResult) => void;
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly detailContainer: Container;
	private filteredItems: PickerItem[] = [];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		theme: Theme,
		keybindings: KeybindingsManager,
		profiles: readonly AgentDefinition[],
		diagnostics: readonly AgentDiagnostic[],
		onDone: (result: ProfilePickerResult) => void,
		initialProfileName?: string,
	) {
		super();
		this.theme = theme;
		this.keybindings = keybindings;
		this.profiles = [...profiles].sort(compareProfileNames);
		this.diagnostics = diagnostics;
		this.onDone = onDone;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Agents")), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.detailContainer = new Container();
		this.addChild(this.detailContainer);
		this.addChild(new Spacer(1));

		const navigationKeys = [keyLabel("tui.select.up", { keybindings }), keyLabel("tui.select.down", { keybindings })]
			.filter(Boolean)
			.join("/");
		const hints = [
			navigationKeys ? `${theme.fg("dim", navigationKeys)}${theme.fg("muted", " navigate")}` : "",
			hint(theme, keybindings, "tui.select.confirm", "configure"),
			hint(theme, keybindings, "tui.select.cancel", "close"),
		].filter(Boolean);
		this.addChild(new Text(hints.join(theme.fg("muted", " • ")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.applyFilter("");
		if (initialProfileName) {
			const initialIndex = this.filteredItems.findIndex(
				(item) => item.kind === "profile" && item.agent.name === initialProfileName,
			);
			if (initialIndex >= 0) this.selectedIndex = initialIndex;
		}
		this.updateView();
	}

	private applyFilter(query: string): void {
		const normalizedQuery = query.trim().toLowerCase();
		const profiles = normalizedQuery
			? this.profiles.filter((agent) =>
					`${agent.name} ${displayAgentName(agent.name)} ${displayAgentDescription(agent)}`
						.toLowerCase()
						.includes(normalizedQuery),
				)
			: this.profiles;
		this.filteredItems = profiles.map((agent): ProfileItem => ({ kind: "profile", agent }));
		if (!normalizedQuery && this.diagnostics.length > 0) {
			this.filteredItems.push({ kind: "diagnostics", count: this.diagnostics.length });
		}
		this.selectedIndex = normalizedQuery
			? 0
			: Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateView();
	}

	private updateView(): void {
		this.listContainer.clear();
		this.detailContainer.clear();

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_PROFILES / 2),
				this.filteredItems.length - MAX_VISIBLE_PROFILES,
			),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_PROFILES, this.filteredItems.length);
		for (let index = startIndex; index < endIndex; index++) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const label =
				item.kind === "profile"
					? displayAgentName(item.agent.name)
					: `View ${item.count} agent file issue${item.count === 1 ? "" : "s"}`;
			const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
			const text = selected ? this.theme.fg("accent", label) : this.theme.fg("text", label);
			this.listContainer.addChild(new TruncatedText(`${prefix}${text}`, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new TruncatedText(
					this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`),
					1,
					0,
				),
			);
		}
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching profiles"), 1, 0));
			return;
		}

		const selected = this.filteredItems[this.selectedIndex];
		if (!selected) return;
		this.detailContainer.addChild(new Spacer(1));
		if (selected.kind === "profile") {
			this.detailContainer.addChild(new Text(this.theme.fg("muted", displayAgentDescription(selected.agent)), 1, 0));
		} else {
			this.detailContainer.addChild(
				new Text(
					this.theme.fg(
						"warning",
						`${selected.count} profile file${selected.count === 1 ? "" : "s"} could not be loaded.`,
					),
					1,
					0,
				),
			);
		}
	}

	private moveSelection(offset: -1 | 1): void {
		if (this.filteredItems.length === 0) return;
		this.selectedIndex = (this.selectedIndex + offset + this.filteredItems.length) % this.filteredItems.length;
		this.updateView();
	}

	private confirm(): void {
		const selected = this.filteredItems[this.selectedIndex];
		if (!selected) return;
		this.onDone(
			selected.kind === "profile" ? { kind: "profile", name: selected.agent.name } : { kind: "diagnostics" },
		);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone(undefined);
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}
}
