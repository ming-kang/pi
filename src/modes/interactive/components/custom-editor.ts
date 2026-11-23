import {
	type AutocompleteItem,
	type AutocompleteProvider,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import {
	isSkillAutocompleteProvider,
	type SkillAutocompleteProvider,
	type SkillCompletion,
} from "../skill-autocomplete.ts";
import type { StatusIndicator } from "./status-indicator.ts";

/** Edits that change text before the cursor without typing it, so they do not open the skill menu. */
const NON_TYPING_EDITS = ["tui.editor.undo", "tui.editor.yank", "tui.editor.yankPop"] as const;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

interface EditPosition {
	line: number;
	col: number;
	lineText: string;
}

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	private skillAutocomplete: SkillAutocompleteProvider | undefined;
	private inBracketedPaste = false;
	/** Start of the `/skill` token whose menu Escape dismissed; typing in that token does not reopen it. */
	private dismissedSkillToken: string | undefined;
	public readonly embedWorkingStatus: boolean;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(provider);
		this.skillAutocomplete = isSkillAutocompleteProvider(provider) ? provider : undefined;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
			return;
		}

		if (this.isShowingAutocomplete() && this.keybindings.matches(data, "tui.select.cancel")) {
			this.dismissedSkillToken = this.getSkillCompletion()?.key;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			this.dismissedSkillToken = undefined;
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		if (
			this.isShowingAutocomplete() &&
			this.keybindings.matches(data, "tui.select.confirm") &&
			(this.getSkillCompletion()?.items.length ?? 0) > 0
		) {
			this.confirmSkillCompletion();
			return;
		}

		if (!this.isShowingAutocomplete() && this.keybindings.matches(data, "tui.input.tab")) {
			this.dismissedSkillToken = undefined;
		}

		const wasInPaste = this.inBracketedPaste;
		const pasteStarts = data.includes(PASTE_START);
		if (pasteStarts) {
			this.inBracketedPaste = true;
		}
		const wasShowingAutocomplete = this.isShowingAutocomplete();
		const before = this.getEditPosition();

		// Pass to parent for editor handling
		super.handleInput(data);

		if (this.inBracketedPaste && data.includes(PASTE_END)) {
			this.inBracketedPaste = false;
		}
		this.updateSkillCompletion(
			!wasInPaste && !pasteStarts && !wasShowingAutocomplete && this.isTypedEdit(data, before),
			wasShowingAutocomplete,
		);
	}

	/** The `/skill` completion at the cursor, keyed by its token start so an Escape dismissal sticks to one token. */
	private getSkillCompletion(): (SkillCompletion & { key: string }) | undefined {
		const { line, col } = this.getCursor();
		const completion = this.skillAutocomplete?.getSkillCompletion(this.getLines(), line, col);
		return completion && { ...completion, key: `${line}:${col - completion.token.prefix.length}` };
	}

	/**
	 * Enter inserts the selected skill like Tab. Routing through Editor's Tab-accept path avoids
	 * first-line command fallthrough (which submits or inserts a newline when Enter is bound to newLine).
	 */
	private confirmSkillCompletion(): void {
		if (this.keybindings.matches("\t", "tui.input.tab")) {
			super.handleInput("\t");
			return;
		}
		const list = (
			this as unknown as {
				autocompleteList?: {
					getSelectedItem?: () => AutocompleteItem | null;
					onSelect?: (item: AutocompleteItem) => void;
				};
			}
		).autocompleteList;
		const selected = list?.getSelectedItem?.();
		if (selected && list?.onSelect) {
			list.onSelect(selected);
		}
	}

	/** Opens the skill menu when typing or deleting leaves the cursor on a `/skill` token, as the Editor does for `@`. */
	private updateSkillCompletion(typed: boolean, wasShowingAutocomplete: boolean): void {
		const completion = this.getSkillCompletion();
		if (completion?.key !== this.dismissedSkillToken) {
			this.dismissedSkillToken = undefined;
		}
		if (!wasShowingAutocomplete && completion && completion.key === this.dismissedSkillToken) {
			// On line 0, Editor.insertCharacter re-triggers autocomplete for `/` contexts; cancel it while dismissed.
			(this as unknown as { cancelAutocomplete?: () => void }).cancelAutocomplete?.();
			return;
		}
		if (
			!typed ||
			!completion ||
			completion.token.hasSpace ||
			completion.items.length === 0 ||
			this.isShowingAutocomplete()
		) {
			return;
		}
		// The Editor has no public trigger; its own `/` and `@` triggers call this private method.
		(this as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete?.();
	}

	private getEditPosition(): EditPosition {
		const { line, col } = this.getCursor();
		return { line, col, lineText: this.getLines()[line] ?? "" };
	}

	/** Whether the input typed or deleted text right before the cursor, as opposed to moving, undoing, or yanking. */
	private isTypedEdit(data: string, before: EditPosition): boolean {
		if (NON_TYPING_EDITS.some((action) => this.keybindings.matches(data, action))) return false;
		const after = this.getEditPosition();
		if (after.line !== before.line || after.lineText.slice(after.col) !== before.lineText.slice(before.col)) {
			return false;
		}
		const textBefore = before.lineText.slice(0, before.col);
		const textAfter = after.lineText.slice(0, after.col);
		return textAfter !== textBefore && (textAfter.startsWith(textBefore) || textBefore.startsWith(textAfter));
	}
}
