import "./keybindings.ts";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	Markdown,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { keyLabel as configuredKeyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { DetailPane } from "./detail-pane.ts";
import { ruleBorder, wrapWithPrefix } from "./dialog-primitives.ts";
import { QUESTION_LIMITS } from "./limits.ts";
import { moreOptionsHint, type WindowItem, windowItems } from "./option-window.ts";
import { PreviewLinesCache, WidthCachedRender } from "./render-cache.ts";
import {
	displayOptions,
	firstUnanswered,
	hasAnswer,
	hasMultiAnswer,
	newQuestionState,
	orderedAnswers,
} from "./state.ts";
import type { DialogResult, DisplayOption, InputMode, Question, QuestionAnswer, QuestionOption } from "./types.ts";

type DialogView = "question" | "review";

/**
 * The dialog replaces the editor in the bottom dock, and the dock grows with its
 * content. Capping the dialog at half the terminal keeps the transcript (often the
 * assistant reply the question refers to) readable while the dialog is open.
 */
const DIALOG_MAX_FRACTION = 0.5;
const DIALOG_MIN_ROWS = 16;
const VIEWPORT_SCROLL_STEP = 4;

interface VerticalViewport {
	lines: string[];
	start: number;
	maxStart: number;
}

function dialogRowBudget(terminalRows: number): number {
	const rows = Math.max(1, Math.floor(terminalRows));
	return Math.min(rows, Math.max(DIALOG_MIN_ROWS, Math.floor(rows * DIALOG_MAX_FRACTION)));
}

/** Clamp `lines` to `maxRows` between the first and last line, scrolling around the anchor. */
function applyVerticalViewport(
	lines: string[],
	width: number,
	maxRows: number,
	theme: Theme,
	options: { anchorLine?: number; preferredStart?: number } = {},
): VerticalViewport {
	if (lines.length <= maxRows) return { lines, start: 0, maxStart: 0 };
	if (maxRows < 5) {
		const anchor = Math.max(0, Math.min(lines.length - 1, options.anchorLine ?? 0));
		const start = Math.max(0, Math.min(lines.length - maxRows, anchor - Math.floor(maxRows / 2)));
		return { lines: lines.slice(start, start + maxRows), start, maxStart: lines.length - maxRows };
	}

	const first = lines[0] ?? "";
	const last = lines[lines.length - 1] ?? "";
	const body = lines.slice(1, -1);
	const contentRows = maxRows - 4;
	const maxStart = Math.max(0, body.length - contentRows);
	const anchorInBody = Math.max(0, Math.min(body.length - 1, (options.anchorLine ?? 1) - 1));
	const requestedStart = options.preferredStart ?? Math.max(0, anchorInBody - Math.floor(contentRows / 2));
	const start = Math.max(0, Math.min(maxStart, requestedStart));
	const bottomHidden = Math.max(0, body.length - start - contentRows);
	const indicator = (text: string) => theme.fg("dim", truncateToWidth(text, Math.max(1, width)));
	return {
		lines: [
			first,
			start > 0 ? indicator(`↑ ${start} rows hidden`) : "",
			...body.slice(start, start + contentRows),
			bottomHidden > 0 ? indicator(`↓ ${bottomHidden} rows hidden`) : "",
			last,
		],
		start,
		maxStart,
	};
}

export function createQuestionDialog(questions: Question[], signal?: AbortSignal) {
	return (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: DialogResult) => void) => {
		let currentIdx = 0;
		let view: DialogView = "question";
		let inputMode: InputMode;
		let noteTarget: string | undefined;
		let notesSnapshot: { prior: QuestionAnswer | undefined } | undefined;
		let reviewScrollOffset = 0;
		let reviewMaxScrollOffset = 0;
		let dialogFocused = false;
		let footerFocused = false;
		let finished = false;
		const cache = new WidthCachedRender();
		const previewCache = new PreviewLinesCache();
		const details = new DetailPane();
		const states = questions.map(() => newQuestionState());
		const optionsByQuestion = questions.map((question) => displayOptions(question));

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
		const currentOptions = () => optionsByQuestion[currentIdx];
		const keyMatches = (data: string, keybinding: Keybinding) => keybindings.matches(data, keybinding);
		const keyLabel = (keybinding: Keybinding) => configuredKeyLabel(keybinding, { keybindings });
		const keyAction = (keybinding: Keybinding, action: string) => {
			const label = keyLabel(keybinding);
			return label ? `${label} ${action}` : "";
		};
		// Editor reads the global TUI manager internally, while dialog controls use the injected manager.
		const editorSubmitAction = (action: string) => {
			const label = configuredKeyLabel("tui.input.submit");
			return label ? `${label} ${action}` : "";
		};
		const keyGroupAction = (bindings: Keybinding[], action: string) => {
			const labels = bindings.map(keyLabel).filter(Boolean).join("/");
			return labels ? `${labels} ${action}` : "";
		};
		const joinHints = (...hints: string[]) => hints.filter(Boolean).join(" • ");

		function finish(result: DialogResult): void {
			if (finished) return;
			finished = true;
			done(result);
		}

		const onAbort = () => finish({ answers: orderedAnswers(questions, states), outcome: "cancelled" });
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		function refresh(): void {
			cache.invalidate();
			tui.requestRender();
		}

		function syncEditorFocus(): void {
			editor.focused = dialogFocused && inputMode !== undefined;
		}

		function setCurrentIdx(index: number): void {
			details.reset();
			currentIdx = Math.max(0, Math.min(questions.length - 1, index));
			view = "question";
			inputMode = undefined;
			noteTarget = undefined;
			reviewScrollOffset = 0;
			reviewMaxScrollOffset = 0;
			notesSnapshot = undefined;
			footerFocused = false;
			editor.setText("");
			syncEditorFocus();
			refresh();
		}

		function clearWarning(): void {
			currentState().warning = undefined;
		}

		function focusedOption(): DisplayOption | undefined {
			return currentOptions()[currentState().optionIndex];
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
			reviewScrollOffset = 0;
			reviewMaxScrollOffset = 0;
			footerFocused = false;
			editor.setText("");
			syncEditorFocus();
			refresh();
		}

		function advanceAfterAnswer(): void {
			if (questions.length === 1 && !currentQuestion().multiSelect) {
				finish({ answers: orderedAnswers(questions, states), outcome: "answered" });
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
			details.reset();
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
			details.reset();
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
			if (!question.multiSelect) {
				notesSnapshot = { prior: state.singleAnswer };
				selectSingleOption(option);
			}
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

		function toggleMultiOption(option: DisplayOption): void {
			const state = currentState();
			if (option.kind === "other") {
				if (state.customAnswer) {
					state.customAnswer.selected = !state.customAnswer.selected;
					clearWarning();
				} else {
					const tabKey = keyLabel("tui.input.tab");
					state.warning = tabKey
						? `Press ${tabKey} to type a custom answer.`
						: "Choose Type something to type a custom answer.";
				}
				return;
			}
			if (state.multiSelected.has(option.optionIndex)) state.multiSelected.delete(option.optionIndex);
			else state.multiSelected.add(option.optionIndex);
			clearWarning();
		}

		function finishReview(): void {
			const missing = firstUnanswered(states);
			if (missing !== undefined) {
				setCurrentIdx(missing);
				currentState().warning = "Answer this question before submitting.";
				refresh();
				return;
			}
			finish({ answers: orderedAnswers(questions, states), outcome: "answered" });
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
				notesSnapshot = undefined;
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
			if (keyMatches(data, "tui.select.up")) {
				reviewScrollOffset = Math.max(0, reviewScrollOffset - VIEWPORT_SCROLL_STEP);
				refresh();
				return;
			}
			if (keyMatches(data, "tui.select.down")) {
				reviewScrollOffset = Math.min(reviewMaxScrollOffset, reviewScrollOffset + VIEWPORT_SCROLL_STEP);
				refresh();
				return;
			}
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
					if (inputMode === "notes" && notesSnapshot) {
						currentState().singleAnswer = notesSnapshot.prior;
					}
					inputMode = undefined;
					noteTarget = undefined;
					notesSnapshot = undefined;
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
			if (keyMatches(data, "app.question.pageUp") || keyMatches(data, "app.question.pageDown")) {
				// Resolve the current pane's height even if another key arrived before a redraw.
				render(tui.terminal.columns);
				details.page(keyMatches(data, "app.question.pageUp") ? -1 : 1);
				refresh();
				return;
			}
			if (keyMatches(data, "tui.editor.cursorRight")) {
				if (currentIdx < questions.length - 1) setCurrentIdx(currentIdx + 1);
				else if (firstUnanswered(states) === undefined) showReview();
				return;
			}

			const state = currentState();
			const options = currentOptions();
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

			if (data.length === 1 && data >= "1" && data <= "9") {
				const index = data.charCodeAt(0) - 49;
				const target = options[index];
				if (target) {
					footerFocused = false;
					state.optionIndex = index;
					clearWarning();
					if (currentQuestion().multiSelect) {
						toggleMultiOption(target);
						refresh();
					} else {
						recordSingle(target);
					}
				}
				return;
			}

			if (footerFocused) {
				if (keyMatches(data, "tui.select.confirm")) {
					finish({ answers: orderedAnswers(questions, states), outcome: "needs_clarification" });
					return;
				}
				if (keyMatches(data, "tui.select.cancel")) {
					finish({ answers: orderedAnswers(questions, states), outcome: "cancelled" });
				}
				return;
			}

			const question = currentQuestion();
			const option = options[state.optionIndex];
			if (question.multiSelect && keyMatches(data, "app.list.toggle")) {
				if (option) toggleMultiOption(option);
				refresh();
				return;
			}

			if (keyMatches(data, "tui.select.confirm")) {
				if (question.multiSelect) {
					if (option?.kind === "other" && !state.customAnswer) {
						beginCustomInput();
						return;
					}
					recordMulti();
				} else if (option) recordSingle(option);
				return;
			}

			if (keyMatches(data, "tui.select.cancel")) {
				finish({ answers: orderedAnswers(questions, states), outcome: "cancelled" });
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
		}

		function previewLines(previewText: string, width: number): string[] {
			return previewCache.get(previewText, width, () =>
				new Markdown(previewText, 1, 0, getMarkdownTheme()).render(Math.max(1, width)),
			);
		}

		/** Multi-select checkbox marker; the other row shows no box until a custom answer exists. */
		function multiMarker(option: DisplayOption, checked: boolean, hasCustomAnswer: boolean): string {
			if (option.kind === "other" && !hasCustomAnswer) return "   ";
			return checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
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
					joinHints(
						keyAction("tui.select.confirm", "submit"),
						keyAction("tui.select.cancel", "edit last question"),
						keyGroupAction(["tui.select.up", "tui.select.down"], "scroll"),
					),
				),
				renderWidth,
				lines,
			);
		}

		/** Chat row, warning, and key hints: always visible below the scrolling option area. */
		function renderQuestionFooter(renderWidth: number, digitRange: string): string[] {
			const state = currentState();
			const isMulti = currentQuestion().multiSelect === true;
			const lines: string[] = [];
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
			let hints: string;
			if (inputMode === "notes") {
				hints = joinHints(editorSubmitAction("save notes"), keyAction("tui.select.cancel", "back"));
			} else if (inputMode === "custom") {
				hints = joinHints(
					editorSubmitAction(isMulti ? "save custom answer" : "continue"),
					keyAction("tui.select.cancel", "back"),
				);
			} else if (footerFocused) {
				hints = joinHints(
					keyAction("tui.select.confirm", "discuss"),
					keyAction("tui.select.up", "return to options"),
					keyAction("tui.select.cancel", "cancel"),
				);
			} else if (isMulti) {
				hints = joinHints(
					keyGroupAction(["tui.select.up", "tui.select.down"], "navigate"),
					`${digitRange} toggle`,
					keyAction("app.list.toggle", "toggle focused"),
					keyAction("tui.input.tab", "notes/custom"),
					keyAction("tui.select.confirm", "continue"),
					questions.length > 1
						? keyGroupAction(["tui.editor.cursorLeft", "tui.editor.cursorRight"], "questions")
						: "",
					keyAction("tui.select.cancel", "cancel"),
				);
			} else {
				hints = joinHints(
					keyGroupAction(["tui.select.up", "tui.select.down"], "navigate"),
					`${digitRange} select`,
					keyAction("tui.input.tab", "notes/custom"),
					keyAction("tui.select.confirm", "select"),
					questions.length > 1
						? keyGroupAction(["tui.editor.cursorLeft", "tui.editor.cursorRight"], "questions")
						: "",
					keyAction("tui.select.cancel", "cancel"),
				);
			}
			// Wrap between actions, so a key stays beside the action it performs.
			let hintLine = "";
			for (const hint of hints.split(" • ")) {
				const joined = hintLine ? `${hintLine} • ${hint}` : hint;
				if (hintLine && visibleWidth(joined) > renderWidth - 1) {
					wrapWithPrefix(" ", theme.fg("dim", hintLine), renderWidth, lines);
					hintLine = hint;
				} else hintLine = joined;
			}
			if (hintLine) wrapWithPrefix(" ", theme.fg("dim", hintLine), renderWidth, lines);
			lines.push(ruleBorder(theme, renderWidth));
			return lines;
		}

		/**
		 * Show whole items from `optionLines` in `rows` rows around `focus`, with
		 * "more options" hints on the sides that have hidden items. `focusRow` is the
		 * row of the focused item's first line.
		 */
		function windowOptionLines(
			optionLines: string[],
			items: WindowItem[],
			focus: number,
			rows: number,
			width: number,
		): { rows: string[]; focusRow: number } {
			const window = windowItems(items, focus, rows);
			const rowsBefore = (count: number) => items.slice(0, count).reduce((sum, item) => sum + item.height, 0);
			const from = rowsBefore(window.first);
			const block = optionLines.slice(from, rowsBefore(window.last + 1));
			const visible = applyVerticalViewport(block, width, window.contentRows, theme, {
				anchorLine: Math.max(
					0,
					block.findIndex((line) => line.includes(CURSOR_MARKER)),
				),
			}).lines;
			if (!window.showAbove && !window.showBelow) return { rows: visible, focusRow: rowsBefore(focus) - from };
			const hint = (direction: "up" | "down", count: number) =>
				theme.fg("dim", ` ${truncateToWidth(moreOptionsHint(direction, count), Math.max(1, width - 1))}`);
			const spare = Array.from({ length: Math.max(0, window.contentRows - visible.length) }, () => "");
			return {
				rows: [
					...(window.showAbove ? [hint("up", window.hiddenAbove)] : []),
					...visible,
					...(window.showBelow ? [hint("down", window.hiddenBelow)] : []),
					...spare,
				],
				focusRow: (window.showAbove ? 1 : 0) + rowsBefore(focus) - from,
			};
		}

		function compute(width: number, terminalRows: number): string[] {
			const lines: string[] = [];
			const renderWidth = Math.max(1, width);
			const maxRows = dialogRowBudget(terminalRows);
			lines.push(ruleBorder(theme, renderWidth));
			renderTabs(renderWidth, lines);

			if (view === "review") {
				renderReview(renderWidth, lines);
				lines.push(ruleBorder(theme, renderWidth));
				const viewport = applyVerticalViewport(lines, renderWidth, maxRows, theme, {
					preferredStart: reviewScrollOffset,
				});
				reviewMaxScrollOffset = viewport.maxStart;
				reviewScrollOffset = viewport.start;
				return viewport.lines;
			}

			const question = currentQuestion();
			const state = currentState();
			const options = currentOptions();
			const isMulti = question.multiSelect === true;
			wrapWithPrefix(" ", theme.fg("text", question.question), renderWidth, lines);

			// The pinned head and footer leave one bounded area for choices and reading.
			const footerLines = renderQuestionFooter(renderWidth, `1-${Math.min(9, options.length)}`);
			const areaRows = Math.max(1, maxRows - lines.length - footerLines.length);
			const sideBySide = !inputMode && renderWidth >= 72;
			// Measure every authored label, reserving the six-column prefix and a checkmark.
			// Saved answers and focus changes must not move the divider or reflow the preview.
			const listWidth = sideBySide
				? Math.min(
						Math.floor((renderWidth - 3) / 2),
						Math.max(
							24,
							...options.map(
								(option, index) => 6 + visibleWidth(`${index + 1}. ${option.label.replace(/\s+/gu, " ")}`) + 2,
							),
						),
					)
				: renderWidth;
			const detailWidth = sideBySide ? renderWidth - listWidth - 3 : renderWidth;

			const optionLines: string[] = [];
			const items: WindowItem[] = [];
			let focusItem = footerFocused ? options.length - 1 : state.optionIndex;
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
				const marker = isMulti ? multiMarker(option, checked, state.customAnswer !== undefined) : "   ";
				const focusArrow = focused ? theme.fg("accent", "→") : " ";
				const note =
					option.kind === "option" && state.notesByOption.has(option.label) ? theme.fg("success", " +note") : "";
				const customText =
					option.kind === "other"
						? (state.customAnswer?.text ??
							(state.singleAnswer?.kind === "custom" ? state.singleAnswer.answer : undefined))
						: undefined;
				const labelText = (customText ? `${option.label}  ✎ ${customText}` : option.label).replace(/\s+/gu, " ");
				const label = `${index + 1}. ${labelText}${selectedSingle ? " ✓" : ""}${note}`;
				const color = focused ? "accent" : selectedSingle || checked ? "success" : "text";
				const row = truncateToWidth(`${focusArrow} ${marker} ${theme.fg(color, label)}`, listWidth);
				optionLines.push(
					focused ? theme.bg("selectedBg", row + " ".repeat(Math.max(0, listWidth - visibleWidth(row)))) : row,
				);
				items.push({ height: 1, countsAsOption: true });
			}

			if (inputMode) {
				const start = optionLines.length;
				const label = inputMode === "notes" ? `Notes for ${noteTarget ?? "option"}:` : "Your answer:";
				optionLines.push(theme.fg("muted", truncateToWidth(` ${label}`, listWidth)));
				for (const line of editor.render(Math.max(1, listWidth - 2))) optionLines.push(` ${line}`);
				items.push({ height: optionLines.length - start, countsAsOption: false });
				focusItem = items.length - 1;
			}

			const regionStart = lines.length;
			let focusRow: number;
			if (inputMode) {
				const windowed = windowOptionLines(optionLines, items, focusItem, areaRows, renderWidth);
				focusRow = windowed.focusRow;
				lines.push(...windowed.rows);
			} else {
				const option = options[state.optionIndex];
				const content: string[] = [];
				const hasPreview = !footerFocused && !isMulti && option.kind === "option" && Boolean(option.preview);
				const title = footerFocused ? "Chat about this" : `${hasPreview ? "Preview" : "Details"} · ${option.label}`;
				// The compact list may elide a long label; its full text stays readable here.
				if (
					!footerFocused &&
					visibleWidth(`${state.optionIndex + 1}. ${option.label.replace(/\s+/gu, " ")}`) > listWidth - 6
				) {
					wrapWithPrefix(" ", theme.fg("text", option.label), detailWidth, content);
				}
				if (footerFocused) {
					wrapWithPrefix(
						" ",
						theme.fg("muted", "Discuss this question before choosing an answer."),
						detailWidth,
						content,
					);
				} else if (option.kind === "option") {
					wrapWithPrefix(" ", theme.fg("muted", option.description), detailWidth, content);
					const note = state.notesByOption.get(option.label);
					if (note) wrapWithPrefix(" ", theme.fg("success", `Note: ${note}`), detailWidth, content);
					if (hasPreview && option.preview) content.push("", ...previewLines(option.preview, detailWidth));
				} else {
					const custom =
						state.customAnswer?.text ??
						(state.singleAnswer?.kind === "custom" ? state.singleAnswer.answer : undefined);
					wrapWithPrefix(
						" ",
						theme.fg("muted", custom || "Write your own answer instead of choosing an option."),
						detailWidth,
						content,
					);
				}
				// On narrow screens reserve reading space first, then show as many compact
				// choices as fit. The focused choice always remains in the list window.
				const optionRows = sideBySide ? areaRows : Math.max(1, Math.min(options.length, areaRows - 4));
				const detailRows = sideBySide ? areaRows : Math.max(1, areaRows - optionRows);
				const left = windowOptionLines(optionLines, items, focusItem, optionRows, listWidth);
				const right = details.render(
					`${currentIdx}:${state.optionIndex}:${footerFocused}`,
					title,
					content,
					detailWidth,
					detailRows,
					keyGroupAction(["app.question.pageUp", "app.question.pageDown"], "scroll"),
					theme,
				);
				focusRow = left.focusRow;
				if (sideBySide) {
					for (let row = 0; row < Math.max(left.rows.length, right.length); row++) {
						const leftText = left.rows[row] ?? "";
						const leftPadded = leftText + " ".repeat(Math.max(0, listWidth - visibleWidth(leftText)));
						lines.push(`${leftPadded}${theme.fg("dim", " │ ")}${right[row] ?? ""}`);
					}
				} else {
					lines.push(...left.rows, ...right);
				}
			}
			const anchorLine = regionStart + focusRow;
			lines.push(...footerLines);
			// Only a terminal too short for the pinned rows has lines left to drop here.
			return applyVerticalViewport(lines, renderWidth, maxRows, theme, { anchorLine }).lines;
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
			dispose() {
				signal?.removeEventListener("abort", onAbort);
			},
		};
	};
}
