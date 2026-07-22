import { Editor, type EditorTheme, Markdown, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { ruleBorder, wrapWithPrefix } from "./dialog-primitives.ts";
import { QUESTION_LIMITS } from "./limits.ts";
import { WidthCachedRender } from "./render-cache.ts";
import {
	displayOptions,
	firstUnanswered,
	hasAnswer,
	hasMultiAnswer,
	newQuestionState,
	orderedAnswers,
} from "./state.ts";
import type { DialogResult, DisplayOption, InputMode, Question, QuestionOption } from "./types.ts";

type DialogView = "question" | "review";

type DialogKeybindings = {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): string[];
};

const PREVIEW_MAX_LINES = 16;
const PREVIEW_CHROME_ROWS = 18;

export function createQuestionDialog(questions: Question[]) {
	return (tui: TUI, theme: Theme, keybindings: unknown, done: (result: DialogResult) => void) => {
		let currentIdx = 0;
		let view: DialogView = "question";
		let inputMode: InputMode;
		let noteTarget: string | undefined;
		let dialogFocused = false;
		let footerFocused = false;
		const cache = new WidthCachedRender();
		const states = questions.map(() => newQuestionState());
		const bindings = keybindings as DialogKeybindings;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const currentQuestion = () => questions[currentIdx];
		const currentState = () => states[currentIdx];
		const keyMatches = (data: string, keybinding: string) => bindings.matches(data, keybinding);
		const keyLabel = (keybinding: string, fallback: string) => bindings.getKeys(keybinding).join("/") || fallback;

		function refresh(): void {
			cache.invalidate();
			tui.requestRender();
		}

		function syncEditorFocus(): void {
			editor.focused = dialogFocused && inputMode !== undefined;
		}

		function setCurrentIdx(index: number): void {
			currentIdx = Math.max(0, Math.min(questions.length - 1, index));
			view = "question";
			inputMode = undefined;
			noteTarget = undefined;
			footerFocused = false;
			editor.setText("");
			syncEditorFocus();
			refresh();
		}

		function clearWarning(): void {
			currentState().warning = undefined;
		}

		function focusedOption(): DisplayOption | undefined {
			return displayOptions(currentQuestion())[currentState().optionIndex];
		}

		function showReview(): void {
			const missing = firstUnanswered(states);
			if (missing !== undefined) {
				setCurrentIdx(missing);
				currentState().warning = "Answer this question before reviewing your answers.";
				refresh();
				return;
			}
			view = "review";
			inputMode = undefined;
			noteTarget = undefined;
			footerFocused = false;
			editor.setText("");
			syncEditorFocus();
			refresh();
		}

		function advanceAfterAnswer(): void {
			if (questions.length === 1 && !currentQuestion().multiSelect) {
				done({ answers: orderedAnswers(questions, states), outcome: "answered" });
				return;
			}
			const missing = firstUnanswered(states);
			if (missing === undefined) {
				showReview();
				return;
			}
			setCurrentIdx(missing);
		}

		function beginCustomInput(): void {
			const state = currentState();
			inputMode = "custom";
			noteTarget = undefined;
			const existingSingle = state.singleAnswer?.kind === "custom" ? state.singleAnswer.answer : undefined;
			editor.setText(state.customAnswer?.text ?? existingSingle ?? "");
			syncEditorFocus();
			refresh();
		}

		function selectSingleOption(option: QuestionOption): void {
			const question = currentQuestion();
			const state = currentState();
			state.singleAnswer = {
				questionIndex: currentIdx,
				question: question.question,
				header: question.header,
				kind: "option",
				answer: option.label,
				...(option.preview ? { preview: option.preview } : {}),
			};
			state.warning = undefined;
		}

		function beginNotesInput(): void {
			const question = currentQuestion();
			const state = currentState();
			const option = focusedOption();
			if (!option || option.kind === "other") {
				beginCustomInput();
				return;
			}
			if (question.multiSelect && !state.multiSelected.has(option.optionIndex)) {
				state.warning = "Select the option first, then add notes.";
				refresh();
				return;
			}
			if (!question.multiSelect) selectSingleOption(option);
			inputMode = "notes";
			noteTarget = option.label;
			editor.setText(state.notesByOption.get(option.label) ?? "");
			syncEditorFocus();
			refresh();
		}

		function recordSingle(option: DisplayOption): void {
			if (option.kind === "other") {
				if (currentState().singleAnswer?.kind === "custom") {
					advanceAfterAnswer();
					return;
				}
				beginCustomInput();
				return;
			}
			selectSingleOption(option);
			advanceAfterAnswer();
		}

		function recordMulti(): void {
			const state = currentState();
			if (!hasMultiAnswer(state)) {
				state.warning = "Select at least one option, type a custom answer, or cancel the questions.";
				refresh();
				return;
			}
			state.warning = undefined;
			advanceAfterAnswer();
		}

		function finishReview(): void {
			const missing = firstUnanswered(states);
			if (missing !== undefined) {
				setCurrentIdx(missing);
				currentState().warning = "Answer this question before submitting.";
				refresh();
				return;
			}
			done({ answers: orderedAnswers(questions, states), outcome: "answered" });
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			const question = currentQuestion();
			const state = currentState();
			if (trimmed.length > QUESTION_LIMITS.userTextChars) {
				state.warning = `Keep notes and custom answers under ${QUESTION_LIMITS.userTextChars} characters.`;
				refresh();
				return;
			}
			if (inputMode === "notes") {
				if (noteTarget) {
					if (trimmed) state.notesByOption.set(noteTarget, trimmed);
					else state.notesByOption.delete(noteTarget);
				}
				inputMode = undefined;
				noteTarget = undefined;
				editor.setText("");
				syncEditorFocus();
				refresh();
				return;
			}

			if (inputMode === "custom") {
				if (!trimmed) {
					inputMode = undefined;
					editor.setText("");
					syncEditorFocus();
					refresh();
					return;
				}
				if (question.multiSelect) {
					state.customAnswer = { text: trimmed, selected: true };
					state.optionIndex = question.options.length;
					inputMode = undefined;
					editor.setText("");
					syncEditorFocus();
					refresh();
					return;
				}
				state.singleAnswer = {
					questionIndex: currentIdx,
					question: question.question,
					header: question.header,
					kind: "custom",
					answer: trimmed,
				};
				inputMode = undefined;
				editor.setText("");
				syncEditorFocus();
				advanceAfterAnswer();
			}
		};

		function handleReviewInput(data: string): void {
			if (keyMatches(data, "tui.editor.cursorLeft")) {
				setCurrentIdx(questions.length - 1);
				return;
			}
			if (keyMatches(data, "tui.select.confirm")) {
				finishReview();
				return;
			}
			if (keyMatches(data, "tui.select.cancel")) {
				setCurrentIdx(questions.length - 1);
			}
		}

		function handleQuestionInput(data: string): void {
			if (inputMode) {
				if (keyMatches(data, "tui.select.cancel")) {
					inputMode = undefined;
					noteTarget = undefined;
					editor.setText("");
					syncEditorFocus();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (keyMatches(data, "tui.editor.cursorLeft")) {
				if (currentIdx > 0) setCurrentIdx(currentIdx - 1);
				return;
			}
			if (keyMatches(data, "tui.editor.cursorRight")) {
				if (currentIdx < questions.length - 1) setCurrentIdx(currentIdx + 1);
				else if (firstUnanswered(states) === undefined) showReview();
				return;
			}

			const state = currentState();
			const options = displayOptions(currentQuestion());
			if (keyMatches(data, "tui.select.up")) {
				if (footerFocused) {
					footerFocused = false;
					state.optionIndex = options.length - 1;
				} else if (state.optionIndex > 0) {
					state.optionIndex--;
				}
				clearWarning();
				refresh();
				return;
			}
			if (keyMatches(data, "tui.select.down")) {
				if (footerFocused) return;
				if (state.optionIndex < options.length - 1) state.optionIndex++;
				else footerFocused = true;
				clearWarning();
				refresh();
				return;
			}
			if (keyMatches(data, "tui.input.tab")) {
				if (!footerFocused) beginNotesInput();
				return;
			}

			if (footerFocused) {
				if (keyMatches(data, "tui.select.confirm")) {
					done({ answers: orderedAnswers(questions, states), outcome: "needs_clarification" });
					return;
				}
				if (keyMatches(data, "tui.select.cancel")) {
					done({ answers: orderedAnswers(questions, states), outcome: "cancelled" });
				}
				return;
			}

			const question = currentQuestion();
			const option = options[state.optionIndex];
			if (question.multiSelect && keyMatches(data, "app.list.toggle")) {
				if (option?.kind === "other") {
					if (state.customAnswer) {
						state.customAnswer.selected = !state.customAnswer.selected;
						clearWarning();
					} else {
						state.warning = `Press ${keyLabel("tui.input.tab", "Tab")} to type a custom answer.`;
					}
					refresh();
					return;
				}
				if (option?.kind === "option") {
					if (state.multiSelected.has(option.optionIndex)) state.multiSelected.delete(option.optionIndex);
					else state.multiSelected.add(option.optionIndex);
				}
				clearWarning();
				refresh();
				return;
			}

			if (keyMatches(data, "tui.select.confirm")) {
				if (question.multiSelect) recordMulti();
				else if (option) recordSingle(option);
				return;
			}

			if (keyMatches(data, "tui.select.cancel")) {
				done({ answers: orderedAnswers(questions, states), outcome: "cancelled" });
			}
		}

		function handleInput(data: string): void {
			if (view === "review") handleReviewInput(data);
			else handleQuestionInput(data);
		}

		function render(width: number): string[] {
			return cache.get(width, tui.terminal.rows, compute);
		}

		function renderTabs(renderWidth: number, lines: string[]): void {
			if (questions.length < 2) return;
			const tabCount = questions.length + 1;
			const headerWidth = Math.max(4, Math.floor((renderWidth - tabCount * 5) / tabCount));
			const tabs = [
				...questions.map((question, index) => {
					const answered = hasAnswer(states[index]);
					const label = ` ${answered ? "■" : "□"} ${truncateToWidth(question.header, headerWidth)} `;
					if (view === "question" && index === currentIdx) {
						return theme.bg("selectedBg", theme.fg(answered ? "success" : "text", label));
					}
					return theme.fg(answered ? "success" : "muted", label);
				}),
				view === "review"
					? theme.bg("selectedBg", theme.fg("text", " ✓ Submit "))
					: theme.fg(firstUnanswered(states) === undefined ? "success" : "dim", " ✓ Submit "),
			].join(" ");
			wrapWithPrefix(" ", tabs, renderWidth, lines);
			lines.push("");
		}

		function previewLines(previewText: string, width: number, terminalRows: number): string[] {
			const markdown = new Markdown(previewText, 1, 0, getMarkdownTheme());
			const rendered = markdown.render(Math.max(1, width));
			const maxLines = Math.max(4, Math.min(PREVIEW_MAX_LINES, terminalRows - PREVIEW_CHROME_ROWS));
			if (rendered.length <= maxLines) return rendered;
			return [
				...rendered.slice(0, maxLines),
				theme.fg(
					"dim",
					truncateToWidth(`… ${rendered.length - maxLines} preview lines hidden`, Math.max(1, width)),
				),
			];
		}

		function renderReview(renderWidth: number, lines: string[]): void {
			wrapWithPrefix(" ", theme.fg("accent", "Review answers"), renderWidth, lines);
			lines.push("");
			for (const answer of orderedAnswers(questions, states)) {
				wrapWithPrefix(
					" ",
					theme.fg("text", `${answer.questionIndex + 1}. ${answer.question}`),
					renderWidth,
					lines,
				);
				const response =
					answer.kind === "multi"
						? (answer.selected?.join(", ") ?? "(no input)")
						: (answer.answer ?? "(no input)");
				wrapWithPrefix("    ", theme.fg("success", response), renderWidth, lines);
				for (const note of answer.notes ?? []) {
					wrapWithPrefix("    ", theme.fg("muted", `Note for ${note.option}: ${note.text}`), renderWidth, lines);
				}
				lines.push("");
			}
			wrapWithPrefix(
				" ",
				theme.fg(
					"dim",
					`${keyLabel("tui.select.confirm", "Enter")} to submit • ${keyLabel("tui.select.cancel", "Esc")} to edit the last question`,
				),
				renderWidth,
				lines,
			);
		}

		function compute(width: number, terminalRows: number): string[] {
			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			lines.push(ruleBorder(theme, renderWidth));
			renderTabs(renderWidth, lines);

			if (view === "review") {
				renderReview(renderWidth, lines);
				lines.push(ruleBorder(theme, renderWidth));
				return lines;
			}

			const question = currentQuestion();
			const state = currentState();
			const options = displayOptions(question);
			const isMulti = question.multiSelect === true;
			wrapWithPrefix(
				" ",
				`${theme.fg("accent", question.header)}  ${theme.fg("text", question.question)}`,
				renderWidth,
				lines,
			);
			lines.push("");

			const optionLines: string[] = [];
			const hasPreview = !isMulti && options.some((option) => option.kind === "option" && option.preview);
			const showPreviewSideBySide = hasPreview && renderWidth >= 60;
			const listWidth = showPreviewSideBySide ? Math.max(20, Math.floor(renderWidth * 0.4)) : renderWidth;

			for (let index = 0; index < options.length; index++) {
				const option = options[index];
				const focused = !footerFocused && index === state.optionIndex;
				const checked =
					isMulti &&
					((option.kind === "option" && state.multiSelected.has(option.optionIndex)) ||
						(option.kind === "other" && state.customAnswer?.selected === true));
				const selectedSingle =
					!isMulti &&
					(option.kind === "other"
						? state.singleAnswer?.kind === "custom"
						: state.singleAnswer?.answer === option.label);
				const marker = isMulti
					? option.kind === "other"
						? state.customAnswer
							? checked
								? theme.fg("success", "[x]")
								: theme.fg("dim", "[ ]")
							: "   "
						: checked
							? theme.fg("success", "[x]")
							: theme.fg("dim", "[ ]")
					: "";
				const focusArrow = focused ? theme.fg("accent", "→") : " ";
				const note =
					option.kind === "option" && state.notesByOption.has(option.label) ? theme.fg("success", " +note") : "";
				const customText =
					option.kind === "other"
						? (state.customAnswer?.text ??
							(state.singleAnswer?.kind === "custom" ? state.singleAnswer.answer : undefined))
						: undefined;
				const labelText = customText ? `${option.label}  ✎ ${customText}` : option.label;
				const label = `${index + 1}. ${labelText}${selectedSingle ? " ✓" : ""}${note}`;
				const color = focused ? "accent" : selectedSingle || checked ? "success" : "text";
				wrapWithPrefix(`${focusArrow} ${marker} `, theme.fg(color, label), listWidth, optionLines);
				if (option.kind === "option" && option.description) {
					wrapWithPrefix("       ", theme.fg("muted", option.description), listWidth, optionLines);
				}
			}

			if (inputMode) {
				optionLines.push("");
				const label = inputMode === "notes" ? `Notes for ${noteTarget ?? "option"}:` : "Your answer:";
				wrapWithPrefix(" ", theme.fg("muted", label), listWidth, optionLines);
				for (const line of editor.render(Math.max(1, listWidth - 2))) optionLines.push(` ${line}`);
			}

			if (showPreviewSideBySide) {
				const gap = 2;
				const rightWidth = renderWidth - listWidth - gap;
				const focused = options[state.optionIndex];
				const previewText = focused?.kind === "option" && focused.preview ? focused.preview : "";
				const rightLines = previewText
					? previewLines(previewText, rightWidth, terminalRows)
					: [theme.fg("dim", "(no preview)")];
				const maxRows = Math.max(optionLines.length, rightLines.length);
				const pad = " ".repeat(gap);
				for (let row = 0; row < maxRows; row++) {
					const left = row < optionLines.length ? optionLines[row] : "";
					const leftPadded = left + " ".repeat(Math.max(0, listWidth - visibleWidth(left)));
					const right = row < rightLines.length ? rightLines[row] : "";
					lines.push(`${leftPadded}${pad}${right}`);
				}
			} else {
				lines.push(...optionLines);
				if (hasPreview) {
					const focused = options[state.optionIndex];
					const previewText = focused?.kind === "option" && focused.preview ? focused.preview : "";
					if (previewText) {
						lines.push("");
						lines.push(ruleBorder(theme, renderWidth, "dim"));
						lines.push(...previewLines(previewText, renderWidth, terminalRows));
					}
				}
			}

			lines.push("");
			const chatPrefix = footerFocused ? theme.fg("accent", "→") : " ";
			wrapWithPrefix(
				`${chatPrefix} `,
				theme.fg(footerFocused ? "accent" : "text", "Chat about this"),
				renderWidth,
				lines,
			);
			if (state.warning) {
				lines.push("");
				wrapWithPrefix(" ", theme.fg("warning", state.warning), renderWidth, lines);
			}
			lines.push("");
			if (inputMode === "notes") {
				wrapWithPrefix(
					" ",
					theme.fg(
						"dim",
						`${keyLabel("tui.select.confirm", "Enter")} to save notes • ${keyLabel("tui.select.cancel", "Esc")} to go back`,
					),
					renderWidth,
					lines,
				);
			} else if (inputMode === "custom") {
				const hint = isMulti ? "to save custom answer" : "to continue";
				wrapWithPrefix(
					" ",
					theme.fg(
						"dim",
						`${keyLabel("tui.select.confirm", "Enter")} ${hint} • ${keyLabel("tui.select.cancel", "Esc")} to go back`,
					),
					renderWidth,
					lines,
				);
			} else if (footerFocused) {
				wrapWithPrefix(
					" ",
					theme.fg(
						"dim",
						`${keyLabel("tui.select.confirm", "Enter")} to discuss • ${keyLabel("tui.select.up", "Up")} to return to options`,
					),
					renderWidth,
					lines,
				);
			} else if (isMulti) {
				wrapWithPrefix(
					" ",
					theme.fg(
						"dim",
						`${keyLabel("app.list.toggle", "Space")} to toggle • ${keyLabel("tui.input.tab", "Tab")} for notes/custom • ${keyLabel("tui.select.confirm", "Enter")} to continue • ${keyLabel("tui.editor.cursorLeft", "Left")}/${keyLabel("tui.editor.cursorRight", "Right")} questions • ${keyLabel("tui.select.cancel", "Esc")} to cancel`,
					),
					renderWidth,
					lines,
				);
			} else {
				wrapWithPrefix(
					" ",
					theme.fg(
						"dim",
						`${keyLabel("tui.input.tab", "Tab")} for notes/custom • ${keyLabel("tui.select.confirm", "Enter")} to select • ${keyLabel("tui.editor.cursorLeft", "Left")}/${keyLabel("tui.editor.cursorRight", "Right")} questions • ${keyLabel("tui.select.cancel", "Esc")} to cancel`,
					),
					renderWidth,
					lines,
				);
			}
			lines.push(ruleBorder(theme, renderWidth));
			return lines;
		}

		return {
			get focused() {
				return dialogFocused;
			},
			set focused(value: boolean) {
				dialogFocused = value;
				syncEditorFocus();
			},
			render,
			invalidate: () => {
				cache.invalidate();
			},
			handleInput,
		};
	};
}
