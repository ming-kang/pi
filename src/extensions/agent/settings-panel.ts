import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export type AgentSettingsAction = "model" | "thinking" | "reset";

/** The current value of a setting row; the reset action row carries no field. */
export interface AgentSettingsField {
	value: string;
	following?: boolean;
	status?: string;
	tone?: "warning" | "error";
}

export interface AgentSettingsRow {
	action: AgentSettingsAction;
	label: string;
	field?: AgentSettingsField;
}

const FOLLOW = " · Follow current session";
const FOLLOW_SHORT = " · follow";
/** Room the value keeps before the full inheritance marker is shown. */
const VALUE_PRIORITY_WIDTH = 12;
/** Room the value keeps once only the compact inheritance marker fits. */
const COMPACT_PRIORITY_WIDTH = 4;

/** Aligned setting rows with one action row, navigated through the host keybindings. */
export class AgentSettingsPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly rows: AgentSettingsRow[];
	private readonly onSelect: (action: AgentSettingsAction) => void;
	private readonly onCancel: () => void;
	private readonly labelWidth: number;
	private selectedIndex: number;
	/** Line index of each row, recorded while rendering so click hit-testing cannot drift. */
	private rowLines: number[] = [];

	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		rows: AgentSettingsRow[],
		selected: AgentSettingsAction,
		onSelect: (action: AgentSettingsAction) => void,
		onCancel: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.rows = rows;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.selectedIndex = Math.max(
			0,
			rows.findIndex((row) => row.action === selected),
		);
		const labels = rows.flatMap((row) => (row.field ? [visibleWidth(row.label)] : []));
		this.labelWidth = Math.max(0, ...labels) + 2;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const border = this.theme.fg("borderMuted", "─".repeat(width));
		const lines = [this.theme.fg("accent", this.theme.bold("Agent Settings")), border];
		this.rowLines = [];
		for (const [index, row] of this.rows.entries()) {
			if (lines.length > 2) lines.push("");
			this.rowLines.push(lines.length);
			lines.push(this.renderRow(row, index === this.selectedIndex, width));
		}
		lines.push(border, ...wrapTextWithAnsi(this.theme.fg("dim", this.hints()), width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.up")) this.move(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.move(1);
		else if (this.keys.matches(data, "tui.select.confirm")) this.select(this.selectedIndex);
		else if (this.keys.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		} else return;
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const index = this.rowLines.indexOf(event.y);
		if (index < 0 || event.button !== "left") return undefined;
		if (event.type === "press") {
			this.selectedIndex = index;
			return { handled: true, focus: true };
		}
		if (event.type !== "click") return undefined;
		this.selectedIndex = index;
		this.select(index);
		return { handled: true, focus: true };
	}

	invalidate(): void {
		this.rowLines = [];
	}

	private move(delta: number): void {
		const count = this.rows.length;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}

	private select(index: number): void {
		const row = this.rows[index];
		if (row) this.onSelect(row.action);
	}

	private renderRow(row: AgentSettingsRow, active: boolean, width: number): string {
		const cursor = active ? this.theme.fg("accent", "› ") : "  ";
		const label = row.field ? row.label + " ".repeat(this.labelWidth - visibleWidth(row.label)) : row.label;
		const heading = cursor + this.theme.fg(active ? "accent" : "muted", label);
		if (!row.field) return truncateToWidth(heading, width);
		return truncateToWidth(heading + this.renderValue(row.field, Math.max(0, width - visibleWidth(heading))), width);
	}

	/** Values keep their room before the inheritance marker degrades, because that marker is the meaning. */
	private renderValue(field: AgentSettingsField, width: number): string {
		if (width < 1) return "";
		const follow = this.followText(field, width);
		const status = field.status ?? "";
		const statusWidth = status ? visibleWidth(status) + 1 : 0;
		const value = truncateToWidth(field.value, Math.max(0, width - visibleWidth(follow) - statusWidth), "…");
		const head = value + (status ? `${value ? " " : ""}${status}` : "");
		const styled = this.theme.fg(field.tone ?? "text", truncateToWidth(head, width));
		if (!follow) return styled;
		const room = width - visibleWidth(styled);
		return room >= visibleWidth(follow) ? styled + this.theme.fg("dim", follow) : styled;
	}

	private followText(field: AgentSettingsField, width: number): string {
		if (!field.following) return "";
		const available = width - (field.status ? visibleWidth(field.status) + 1 : 0);
		if (visibleWidth(FOLLOW) + VALUE_PRIORITY_WIDTH <= available) return FOLLOW;
		if (visibleWidth(FOLLOW_SHORT) + COMPACT_PRIORITY_WIDTH <= available) return FOLLOW_SHORT;
		return "";
	}

	private hints(): string {
		const navigation = [this.key("tui.select.up"), this.key("tui.select.down")].filter(Boolean).join("/");
		const confirm = this.key("tui.select.confirm");
		const cancel = this.key("tui.select.cancel");
		return [navigation && `${navigation} navigate`, confirm && `${confirm} change`, cancel && `${cancel} close`]
			.filter(Boolean)
			.join(" · ");
	}

	private key(action: Parameters<typeof keyLabel>[0]): string {
		return keyLabel(action, { keybindings: this.keys });
	}
}
