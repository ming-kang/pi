import type {
	EditorHost,
	EditorSubmitEvent,
	EditorSubmitHandler,
	TerminalInputHandler,
} from "../../core/extensions/index.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";

/** Optional capabilities of the native and custom editors. */
interface EditorCapabilities {
	getCursor?(): { line: number; col: number };
	isShowingAutocomplete?(): boolean;
}

/** Built-in commands dispatched by the editor but not listed for autocomplete. */
const HIDDEN_BUILTIN_COMMANDS = ["debug", "arminsayshi", "dementedelves"];

export interface InteractiveEditorHostOptions {
	/** Whether `/name` is an extension command, prompt template or skill in the current session. */
	isSessionCommand(name: string): boolean;
	/** The active main editor, which may be an extension's custom editor. */
	getEditor(): unknown;
	getFocusedComponent(): unknown;
	hasOverlay(): boolean;
	/** Subscribe through the host's terminal listener registry so renderer switches rebind it. */
	addTerminalInputListener(handler: TerminalInputHandler): () => void;
	setEditorText(text: string): void;
	requestRender(): void;
	showError(message: string): void;
}

/**
 * The interactive TUI's EditorHost. InteractiveMode offers each submission here before
 * history, command dispatch and queueing, so a claimed input never reaches the main agent.
 */
export class InteractiveEditorHost implements EditorHost {
	private readonly submitHandlers = new Set<EditorSubmitHandler>();
	private readonly options: InteractiveEditorHostOptions;
	private declinedFollowUp: string | undefined;

	constructor(options: InteractiveEditorHostOptions) {
		this.options = options;
	}

	onSubmit(handler: EditorSubmitHandler): () => void {
		this.submitHandlers.add(handler);
		return () => this.submitHandlers.delete(handler);
	}

	getCursor(): { line: number; col: number } | undefined {
		return (this.options.getEditor() as EditorCapabilities).getCursor?.();
	}

	onInput(handler: TerminalInputHandler): () => void {
		return this.options.addTerminalInputListener((data) => (this.isEditorFocused() ? handler(data) : undefined));
	}

	/** Selectors, overlays and autocomplete keep priority over editor-scoped input. */
	private isEditorFocused(): boolean {
		const editor = this.options.getEditor() as EditorCapabilities;
		return (
			this.options.getFocusedComponent() === editor &&
			!this.options.hasOverlay() &&
			!editor.isShowingAutocomplete?.()
		);
	}

	/** Drop submit handlers registered by a replaced extension generation. */
	clear(): void {
		this.submitHandlers.clear();
	}

	classify(text: string): EditorSubmitEvent["kind"] {
		if (text.startsWith("!")) return "bash";
		if (!text.startsWith("/")) return "prompt";
		const name = text.slice(1).split(/\s/, 1)[0];
		return BUILTIN_SLASH_COMMANDS.some((command) => command.name === name) ||
			HIDDEN_BUILTIN_COMMANDS.includes(name) ||
			this.options.isSessionCommand(name)
			? "command"
			: "prompt";
	}

	/**
	 * Offer trimmed editor text to handlers. Returns true when one claimed it.
	 *
	 * An idle follow-up falls through to Enter synchronously, so a follow-up the handlers
	 * declined is not offered again as Enter in the same tick.
	 */
	intercept(text: string, mode: EditorSubmitEvent["mode"]): boolean {
		if (mode === "steer" && this.declinedFollowUp === text) return false;
		if (this.submitHandlers.size === 0) return false;
		const event: EditorSubmitEvent = { text, mode, kind: this.classify(text) };
		for (const handler of this.submitHandlers) {
			try {
				const result = handler(event);
				if (!result?.handled) continue;
				this.options.setEditorText(result.editorText ?? "");
				this.options.requestRender();
				return true;
			} catch (error) {
				// A failed interceptor must not accidentally send private input to the main agent.
				this.options.setEditorText(text);
				this.options.showError(
					`Editor submit handler failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return true;
			}
		}
		if (mode === "followUp") {
			this.declinedFollowUp = text;
			queueMicrotask(() => {
				this.declinedFollowUp = undefined;
			});
		}
		return false;
	}
}
