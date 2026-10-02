import "./keybindings.ts";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { type DialogSnapshot, QuestionDialogView } from "./dialog-view.ts";
import { QUESTION_LIMITS } from "./limits.ts";
import { WidthCachedRender } from "./render-cache.ts";
import { customText, displayOptions, firstUnanswered, hasAnswer, newQuestionState, orderedAnswers } from "./state.ts";
import type { DialogMode, DialogResult, DisplayOption, Question } from "./types.ts";

export function createQuestionDialog(questions: readonly Question[], signal?: AbortSignal) {
	return (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: DialogResult) => void) => {
		const states = questions.map(newQuestionState);
		const optionsByQuestion = questions.map(displayOptions);
		let current = 0;
		let mode: DialogMode = { kind: "choose" };
		let dialogFocused = false;
		let finished = false;
		const cache = new WidthCachedRender();
		const view = new QuestionDialogView(theme, keybindings);
		const editor = new Editor(tui, {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		} satisfies EditorTheme);

		const keyMatches = (data: string, keybinding: Keybinding) => keybindings.matches(data, keybinding);
		const state = () => states[current];
		const options = () => optionsByQuestion[current];
		const isEditing = () => mode.kind === "custom" || mode.kind === "notes";
		const snapshot = (): DialogSnapshot => ({ questions, states, current, options: options(), mode, editor });

		function refresh(): void {
			cache.invalidate();
			tui.requestRender();
		}

		/** The one place the mode changes: scrolling restarts, and the editor gets its text and focus. */
		function setMode(next: DialogMode, editorText = ""): void {
			mode = next;
			view.resetScroll();
			editor.setText(editorText);
			editor.focused = dialogFocused && isEditing();
			refresh();
		}

		function finish(outcome: DialogResult["outcome"]): void {
			if (finished) return;
			finished = true;
			done({ outcome, answers: orderedAnswers(questions, states) });
		}

		/** Leave an editor without saving; notes on a single-select question undo their tentative selection. */
		function discardEdit(): void {
			const draft = state().draft;
			if (mode.kind === "notes" && draft.kind === "single") draft.choice = mode.previous;
		}

		const onAbort = () => {
			discardEdit();
			finish("cancelled");
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		function goTo(index: number, warning?: string): void {
			current = Math.max(0, Math.min(questions.length - 1, index));
			if (warning) state().warning = warning;
			setMode({ kind: "choose" });
		}

		/** After an answer: finish a lone single-select question, else review or move to the next unanswered one. */
		function advance(): void {
			if (questions.length === 1 && state().draft.kind === "single") {
				finish("answered");
				return;
			}
			const missing = firstUnanswered(states);
			if (missing === undefined) setMode({ kind: "review" });
			else goTo(missing);
		}

		function editCustom(): void {
			setMode({ kind: "custom" }, customText(state()) ?? "");
		}

		function editNotes(option: DisplayOption): void {
			const target = state();
			const draft = target.draft;
			if (option.kind === "other") {
				editCustom();
				return;
			}
			if (draft.kind === "multi" && !draft.selected.has(option.optionIndex)) {
				target.warning = "Select the option first, then add notes.";
				refresh();
				return;
			}
			const previous = draft.kind === "single" ? draft.choice : undefined;
			if (draft.kind === "single") {
				draft.choice = { kind: "option", index: option.optionIndex };
				target.warning = undefined;
			}
			setMode({ kind: "notes", option: option.optionIndex, previous }, target.notes.get(option.optionIndex) ?? "");
		}

		function pickSingle(option: DisplayOption): void {
			const target = state();
			if (target.draft.kind !== "single") return;
			if (option.kind === "other") {
				if (target.draft.choice?.kind === "custom") advance();
				else editCustom();
				return;
			}
			target.draft.choice = { kind: "option", index: option.optionIndex };
			target.warning = undefined;
			advance();
		}

		function toggleMulti(option: DisplayOption): void {
			const target = state();
			const draft = target.draft;
			if (draft.kind !== "multi") return;
			target.warning = undefined;
			if (option.kind === "option") {
				if (!draft.selected.delete(option.optionIndex)) draft.selected.add(option.optionIndex);
			} else if (draft.custom) {
				draft.custom.selected = !draft.custom.selected;
			} else {
				const tabKey = keyLabel("tui.input.tab", { keybindings });
				target.warning = tabKey
					? `Press ${tabKey} to type a custom answer.`
					: "Choose Type something to type a custom answer.";
			}
			refresh();
		}

		function submitMulti(): void {
			const target = state();
			if (hasAnswer(target)) {
				target.warning = undefined;
				advance();
				return;
			}
			target.warning = "Select at least one option, type a custom answer, or cancel the questions.";
			refresh();
		}

		editor.onSubmit = (value) => {
			const target = state();
			const text = value.trim();
			if (text.length > QUESTION_LIMITS.userTextChars) {
				target.warning = `Keep notes and custom answers under ${QUESTION_LIMITS.userTextChars} characters.`;
				// The editor clears itself before submitting; give the text back to shorten.
				editor.setText(text);
				refresh();
				return;
			}
			target.warning = undefined;
			const draft = target.draft;
			if (mode.kind === "notes") {
				if (text) target.notes.set(mode.option, text);
				else target.notes.delete(mode.option);
				setMode({ kind: "choose" });
				return;
			}
			// An empty custom answer leaves any saved one unchanged.
			if (!text) {
				setMode({ kind: "choose" });
				return;
			}
			if (draft.kind === "multi") {
				draft.custom = { text, selected: true };
				target.focus = options().length - 1;
				setMode({ kind: "choose" });
				return;
			}
			draft.choice = { kind: "custom", text };
			setMode({ kind: "choose" });
			advance();
		};

		function handleReviewInput(data: string): void {
			if (keyMatches(data, "tui.select.up") || keyMatches(data, "tui.select.down")) {
				view.scrollReview(keyMatches(data, "tui.select.up") ? -1 : 1);
				refresh();
			} else if (keyMatches(data, "tui.select.confirm")) {
				const missing = firstUnanswered(states);
				if (missing === undefined) finish("answered");
				else goTo(missing, "Answer this question before submitting.");
			} else if (keyMatches(data, "tui.editor.cursorLeft") || keyMatches(data, "tui.select.cancel")) {
				goTo(questions.length - 1);
			}
		}

		function handleEditorInput(data: string): void {
			if (keyMatches(data, "tui.select.cancel")) {
				discardEdit();
				setMode({ kind: "choose" });
				return;
			}
			editor.handleInput(data);
			refresh();
		}

		function handleChoiceInput(data: string): void {
			const chat = mode.kind === "chat";
			const target = state();
			const choices = options();
			const multi = target.draft.kind === "multi";
			if (keyMatches(data, "tui.editor.cursorLeft")) {
				if (current > 0) goTo(current - 1);
			} else if (keyMatches(data, "tui.editor.cursorRight")) {
				if (current < questions.length - 1) goTo(current + 1);
				else if (firstUnanswered(states) === undefined) setMode({ kind: "review" });
			} else if (keyMatches(data, "app.question.pageUp") || keyMatches(data, "app.question.pageDown")) {
				view.pageDetails(snapshot(), keyMatches(data, "app.question.pageUp") ? -1 : 1);
				refresh();
			} else if (keyMatches(data, "tui.select.up")) {
				target.warning = undefined;
				if (chat) {
					target.focus = choices.length - 1;
					setMode({ kind: "choose" });
					return;
				}
				target.focus = Math.max(0, target.focus - 1);
				refresh();
			} else if (keyMatches(data, "tui.select.down")) {
				if (chat) return;
				target.warning = undefined;
				if (target.focus < choices.length - 1) {
					target.focus++;
					refresh();
				} else setMode({ kind: "chat" });
			} else if (keyMatches(data, "tui.input.tab")) {
				if (!chat) editNotes(choices[target.focus]);
			} else if (data.length === 1 && data >= "1" && data <= "9") {
				const index = data.charCodeAt(0) - 49;
				const option = choices[index];
				if (!option) return;
				target.focus = index;
				target.warning = undefined;
				if (chat) setMode({ kind: "choose" });
				if (multi) toggleMulti(option);
				else pickSingle(option);
			} else if (chat) {
				if (keyMatches(data, "tui.select.confirm")) finish("needs_clarification");
				else if (keyMatches(data, "tui.select.cancel")) finish("cancelled");
			} else if (multi && keyMatches(data, "app.list.toggle")) {
				toggleMulti(choices[target.focus]);
			} else if (keyMatches(data, "tui.select.confirm")) {
				const option = choices[target.focus];
				if (!multi) pickSingle(option);
				else if (option.kind === "other" && customText(target) === undefined) editCustom();
				else submitMulti();
			} else if (keyMatches(data, "tui.select.cancel")) {
				finish("cancelled");
			}
		}

		function render(width: number): string[] {
			return cache.get(width, tui.terminal.rows, (renderWidth, rows) => view.render(snapshot(), renderWidth, rows));
		}

		return {
			get focused() {
				return dialogFocused;
			},
			set focused(value: boolean) {
				dialogFocused = value;
				editor.focused = dialogFocused && isEditing();
			},
			render,
			invalidate: () => {
				cache.invalidate();
			},
			handleInput(data: string): void {
				if (mode.kind === "review") handleReviewInput(data);
				else if (isEditing()) handleEditorInput(data);
				else handleChoiceInput(data);
			},
			dispose() {
				signal?.removeEventListener("abort", onAbort);
			},
		};
	};
}
