/**
 * Advanced sub-pages for rarely edited models.json fields. Every row edits
 * one JSON path through the same handle as the basic fields, so a custom
 * model defines the value and a built-in model overrides it. Object values
 * edit as one line of JSON and are checked against the models.json schema
 * before they are written.
 */

import "../keybindings.ts";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { ModelsJsonSchemas } from "../../../core/model-config.ts";
import { keyHint, rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { plural } from "../constants.ts";
import { getPath } from "../json-fields.ts";
import { DELETE } from "../store.ts";
import { CompatPane } from "./compat.ts";
import { InlineEdit, moveSelection } from "./controls.ts";
import type { CompatFields, EditorPane, FieldsHandle, ProviderPaneHost } from "./pane.ts";
import {
	fieldOrigin,
	isPrintableInput,
	renderErrorLines,
	renderInfoLine,
	renderKeyValueLine,
	type ScrollWindowInfo,
} from "./value-row.ts";

/** One editable path: `text` and `toggle` are scalars, `json` is any schema-checked value, `compat` opens the compat page. */
interface AdvancedField {
	readonly path: readonly string[];
	readonly kind: "text" | "toggle" | "json" | "compat";
	readonly schema?: TSchema;
}

/** What an Advanced page edits: a model handle as is, or the provider entry, which inherits nothing. */
type AdvancedTarget = Pick<FieldsHandle, "setField"> & {
	read(): object;
	own(): object;
	base(): object | undefined;
};

const MODEL = ModelsJsonSchemas.model.properties;
const PROVIDER = ModelsJsonSchemas.provider.properties;
/** pi-ai's cost schema is plain JSON Schema behind Type.Unsafe (v1.5.0), so TypeBox does not type its properties. */
const COST_TIERS = (MODEL.cost as unknown as { properties: { tiers: TSchema } }).properties.tiers;

/** Model fields shared by models entries and modelOverrides entries; the schemas agree on all of them. */
export const MODEL_ADVANCED_FIELDS: readonly AdvancedField[] = [
	{ path: ["headers"], kind: "json", schema: MODEL.headers },
	{ path: ["samplingParams"], kind: "json", schema: MODEL.samplingParams },
	{ path: ["samplingParamsByThinkingLevel"], kind: "json", schema: MODEL.samplingParamsByThinkingLevel },
	{ path: ["promptCache"], kind: "json", schema: MODEL.promptCache },
	{ path: ["inputLimits"], kind: "json", schema: MODEL.inputLimits },
	{ path: ["cost", "tiers"], kind: "json", schema: COST_TIERS },
];

export const PROVIDER_ADVANCED_FIELDS: readonly AdvancedField[] = [
	{ path: ["name"], kind: "text", schema: PROVIDER.name },
	{ path: ["headers"], kind: "json", schema: PROVIDER.headers },
	{ path: ["authHeader"], kind: "toggle" },
	{ path: ["compat"], kind: "compat" },
];

function isEmptyValue(value: unknown): boolean {
	return value === undefined || (typeof value === "object" && value !== null && Object.keys(value).length === 0);
}

/** Note for the row that opens an Advanced page: the fields this models.json sets itself. */
export function advancedNote(target: AdvancedTarget, fields: readonly AdvancedField[]): string {
	const own = target.own();
	const set = fields.filter((field) => !isEmptyValue(getPath(own, field.path))).map((field) => field.path.join("."));
	return set.length ? `· set: ${set.join(", ")}` : "· none set";
}

export function providerAdvancedTarget(host: ProviderPaneHost): AdvancedTarget {
	const read = () => host.store.getProvider(host.providerId) ?? {};
	return {
		read,
		own: read,
		base: () => undefined,
		setField: (path, value) => host.edits.setProviderField(path, value),
	};
}

/** Provider-level compat through the model compat page: same keys, written to the provider entry. */
function providerCompatHandle(host: ProviderPaneHost): CompatFields {
	return {
		read: () => ({ compat: host.store.getProvider(host.providerId)?.compat }),
		setField: (path, value) => host.edits.setProviderField(path, value),
	};
}

function displayValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parse and schema-check one edited value; returns the value or an error message. */
export function parseAdvancedValue(field: AdvancedField, raw: string): { value: unknown } | { error: string } {
	const label = field.path.join(".");
	let value: unknown = raw;
	if (field.kind === "json") {
		try {
			value = JSON.parse(raw);
		} catch (error) {
			return { error: `${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})` };
		}
	}
	if (field.schema) {
		const [first] = Compile(field.schema).Errors(value);
		if (first) {
			const at = first.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return { error: `${label}${at ? `.${at}` : ""}: ${first.message}` };
		}
	}
	return { value };
}

export class AdvancedPane implements EditorPane {
	readonly crumb = "Advanced";
	private index = 0;
	private focused = false;
	/** Lines below the rows in the last render: error, legend. */
	private footerLines = 0;
	private readonly edit: InlineEdit<AdvancedField>;

	private readonly host: ProviderPaneHost;
	private readonly target: AdvancedTarget;
	private readonly fields: readonly AdvancedField[];
	constructor(host: ProviderPaneHost, target: AdvancedTarget, fields: readonly AdvancedField[]) {
		this.host = host;
		this.target = target;
		this.fields = fields;
		this.edit = new InlineEdit(() => host.refresh());
	}

	render(width: number): string[] {
		const theme = this.host.theme;
		const lines = this.fields.map((field, rowIndex) => this.renderRow(field, rowIndex === this.index, width));
		if (this.edit.error) lines.push(...renderErrorLines(theme, this.edit.error, width));
		const field = this.fields[this.index];
		const legend =
			field?.kind === "json"
				? "Values are one-line JSON, checked against the models.json schema; empty clears."
				: field?.kind === "toggle"
					? "Space or Enter cycles true → false → not set."
					: undefined;
		if (legend) lines.push(renderInfoLine(theme, legend, width));
		if (this.target.base())
			lines.push(renderInfoLine(theme, "Dim values are built in; overrides replace or merge.", width));
		this.footerLines = lines.length - this.fields.length;
		return lines;
	}

	private renderRow(field: AdvancedField, active: boolean, width: number): string {
		const theme = this.host.theme;
		const own = getPath(this.target.own(), field.path);
		const effective = getPath(this.target.read(), field.path);
		const base = { keyLabel: field.path.join("."), active, paneFocused: this.focused, width };
		if (field.kind === "compat") {
			const count = Object.keys((own as object | undefined) ?? {}).length;
			return renderKeyValueLine(theme, {
				...base,
				valueText: count > 0 ? `${count} ${plural(count, "entry")}` : "not set",
				unset: count === 0,
				note: "· applies to every model of this provider",
			});
		}
		// An unset field shows what applies anyway: the built-in value, or the default.
		const shown = own !== undefined ? own : effective;
		const fallback = field.kind === "toggle" ? "false (default)" : "not set";
		return renderKeyValueLine(theme, {
			...base,
			valueText: shown === undefined ? fallback : displayValue(shown),
			...fieldOrigin(this.target, field.path),
			editing: this.edit.editor(field),
		});
	}

	scrollWindow(): ScrollWindowInfo {
		return { bottom: this.footerLines, cursor: this.index };
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (this.edit.handleInput(data, kb)) return;
		const next = moveSelection(kb, data, this.index, this.fields.length);
		if (next !== undefined) {
			this.index = next;
			this.edit.error = undefined;
			this.host.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.host.popPane();
			return;
		}
		const field = this.fields[this.index]!;
		const confirm = kb.matches(data, "tui.select.confirm");
		if (field.kind === "compat") {
			if (confirm) this.host.pushPane(new CompatPane(this.host, providerCompatHandle(this.host)));
			return;
		}
		if (field.kind === "toggle") {
			if (confirm || kb.matches(data, "app.list.toggle")) this.cycle(field);
			return;
		}
		if (confirm) this.beginEdit(field, "tweak");
		else if (isPrintableInput(data)) this.beginEdit(field, "overwrite", data);
	}

	private cycle(field: AdvancedField): void {
		const current = getPath(this.target.own(), field.path);
		this.target.setField(field.path, current === undefined ? true : current === true ? false : DELETE);
	}

	private beginEdit(field: AdvancedField, mode: "overwrite" | "tweak", firstData?: string): void {
		const own = getPath(this.target.own(), field.path);
		this.edit.begin(
			field,
			own === undefined ? "" : displayValue(own),
			mode,
			this.focused,
			(raw) => this.commit(field, raw),
			firstData,
		);
	}

	private commit(field: AdvancedField, raw: string): string | undefined {
		const text = raw.trim();
		if (text === "") {
			this.target.setField(field.path, DELETE);
			return undefined;
		}
		const parsed = parseAdvancedValue(field, text);
		if ("error" in parsed) return parsed.error;
		this.target.setField(field.path, parsed.value);
		return undefined;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.edit.setFocused(focused);
	}

	isEditing(): boolean {
		return this.edit.editing;
	}

	hints(): string {
		if (this.edit.editing) {
			return [keyHint("tui.input.submit", "save"), keyHint("tui.select.cancel", "cancel")].join("  ");
		}
		const back = keyHint("tui.select.cancel", "back");
		switch (this.fields[this.index]?.kind) {
			case "compat":
				return [keyHint("tui.select.confirm", "open"), back].join("  ");
			case "toggle":
				return [keyHint("tui.select.confirm", "cycle"), back].join("  ");
			default:
				return [rawKeyHint("type", "overwrite"), keyHint("tui.select.confirm", "edit"), back].join("  ");
		}
	}
}
