import { CURSOR_MARKER, type Editor, Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Keybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { keyLabel as configuredKeyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { DetailPane } from "./detail-pane.ts";
import { ruleBorder, wrapWithPrefix } from "./dialog-primitives.ts";
import { moreOptionsHint, type WindowItem, windowItems } from "./option-window.ts";
import { PreviewLinesCache } from "./render-cache.ts";
import { answerScalar } from "./results.ts";
import { customText, firstUnanswered, hasAnswer, isSelected, orderedAnswers } from "./state.ts";
import type { DialogMode, DisplayOption, Question, QuestionState } from "./types.ts";

/**
 * The dialog replaces the editor in the bottom dock, and the dock grows with its
 * content. Capping the dialog at half the terminal keeps the transcript (often the
 * assistant reply the question refers to) readable while the dialog is open.
 */
const DIALOG_MAX_FRACTION = 0.5;
const DIALOG_MIN_ROWS = 16;
const VIEWPORT_SCROLL_STEP = 4;

/** Everything the view reads; the dialog owns and changes it. */
export interface DialogSnapshot {
	questions: readonly Question[];
	states: readonly QuestionState[];
	current: number;
	options: readonly DisplayOption[];
	mode: DialogMode;
	editor: Editor;
}

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

function detailKey(snapshot: DialogSnapshot): string {
	return `${snapshot.current}:${snapshot.states[snapshot.current].focus}:${snapshot.mode.kind === "chat"}`;
}

const joinHints = (...hints: string[]) => hints.filter(Boolean).join(" • ");

/** Lays out the question dialog and owns its display-only scroll positions. */
export class QuestionDialogView {
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly details = new DetailPane();
	private readonly previews = new PreviewLinesCache();
	private reviewScroll = 0;
	private reviewMaxScroll = 0;

	constructor(theme: Theme, keybindings: KeybindingsManager) {
		this.theme = theme;
		this.keybindings = keybindings;
	}

	resetScroll(): void {
		this.details.reset();
		this.reviewScroll = 0;
		this.reviewMaxScroll = 0;
	}

	pageDetails(snapshot: DialogSnapshot, direction: -1 | 1): void {
		this.details.page(detailKey(snapshot), direction);
	}

	scrollReview(direction: -1 | 1): void {
		this.reviewScroll = Math.max(
			0,
			Math.min(this.reviewMaxScroll, this.reviewScroll + direction * VIEWPORT_SCROLL_STEP),
		);
	}

	render(snapshot: DialogSnapshot, width: number, terminalRows: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const renderWidth = Math.max(1, width);
		const maxRows = dialogRowBudget(terminalRows);
		lines.push(ruleBorder(theme, renderWidth));
		this.renderTabs(snapshot, renderWidth, lines);

		if (snapshot.mode.kind === "review") {
			this.renderReview(snapshot, renderWidth, lines);
			lines.push(ruleBorder(theme, renderWidth));
			const viewport = applyVerticalViewport(lines, renderWidth, maxRows, theme, {
				preferredStart: this.reviewScroll,
			});
			this.reviewMaxScroll = viewport.maxStart;
			this.reviewScroll = viewport.start;
			return viewport.lines;
		}

		const { mode, options, editor } = snapshot;
		const question = snapshot.questions[snapshot.current];
		const state = snapshot.states[snapshot.current];
		const isMulti = state.draft.kind === "multi";
		const chat = mode.kind === "chat";
		const editing = mode.kind === "custom" || mode.kind === "notes";
		wrapWithPrefix(" ", theme.fg("text", question.question), renderWidth, lines);

		// The pinned head and footer leave one bounded area for choices and reading.
		const footerLines = this.renderFooter(snapshot, renderWidth, `1-${Math.min(9, options.length)}`);
		const areaRows = Math.max(1, maxRows - lines.length - footerLines.length);
		const sideBySide = !editing && renderWidth >= 72;
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

		const custom = customText(state);
		const optionLines: string[] = [];
		const items: WindowItem[] = [];
		let focusItem = chat ? options.length - 1 : state.focus;
		for (let index = 0; index < options.length; index++) {
			const option = options[index];
			const focused = !chat && index === state.focus;
			const selected = isSelected(state, option);
			// Multi-select checkbox; the other row shows no box until a custom answer exists.
			const marker = !isMulti
				? "   "
				: option.kind === "other" && custom === undefined
					? "   "
					: selected
						? theme.fg("success", "[x]")
						: theme.fg("dim", "[ ]");
			const focusArrow = focused ? theme.fg("accent", "→") : " ";
			const note =
				option.kind === "option" && state.notes.has(option.optionIndex) ? theme.fg("success", " +note") : "";
			const otherText = option.kind === "other" ? custom : undefined;
			const labelText = (otherText ? `${option.label}  ✎ ${otherText}` : option.label).replace(/\s+/gu, " ");
			const checkmark = selected && !isMulti ? " ✓" : "";
			const label = `${index + 1}. ${labelText}${checkmark}${note}`;
			const color = focused ? "accent" : selected ? "success" : "text";
			const row = truncateToWidth(`${focusArrow} ${marker} ${theme.fg(color, label)}`, listWidth);
			optionLines.push(
				focused ? theme.bg("selectedBg", row + " ".repeat(Math.max(0, listWidth - visibleWidth(row)))) : row,
			);
			items.push({ height: 1, countsAsOption: true });
		}

		if (editing) {
			const start = optionLines.length;
			const label = mode.kind === "notes" ? `Notes for ${question.options[mode.option].label}:` : "Your answer:";
			optionLines.push(theme.fg("muted", truncateToWidth(` ${label}`, listWidth)));
			for (const line of editor.render(Math.max(1, listWidth - 2))) optionLines.push(` ${line}`);
			items.push({ height: optionLines.length - start, countsAsOption: false });
			focusItem = items.length - 1;
		}

		const regionStart = lines.length;
		let focusRow: number;
		if (editing) {
			const windowed = this.windowOptionLines(optionLines, items, focusItem, areaRows, renderWidth);
			focusRow = windowed.focusRow;
			lines.push(...windowed.rows);
		} else {
			const option = options[state.focus];
			const content: string[] = [];
			const hasPreview = !chat && option.kind === "option" && Boolean(option.preview);
			const title = chat ? "Chat about this" : `${hasPreview ? "Preview" : "Details"} · ${option.label}`;
			// The compact list may elide a long label; its full text stays readable here.
			if (!chat && visibleWidth(`${state.focus + 1}. ${option.label.replace(/\s+/gu, " ")}`) > listWidth - 6) {
				wrapWithPrefix(" ", theme.fg("text", option.label), detailWidth, content);
			}
			if (chat) {
				wrapWithPrefix(
					" ",
					theme.fg("muted", "Discuss this question before choosing an answer."),
					detailWidth,
					content,
				);
			} else if (option.kind === "option") {
				wrapWithPrefix(" ", theme.fg("muted", option.description), detailWidth, content);
				const note = state.notes.get(option.optionIndex);
				if (note) wrapWithPrefix(" ", theme.fg("success", `Note: ${note}`), detailWidth, content);
				if (hasPreview && option.preview) content.push("", ...this.previewLines(option.preview, detailWidth));
			} else {
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
			const left = this.windowOptionLines(optionLines, items, focusItem, optionRows, listWidth);
			const right = this.details.render(
				detailKey(snapshot),
				title,
				content,
				detailWidth,
				detailRows,
				this.keyGroupAction(["app.question.pageUp", "app.question.pageDown"], "scroll"),
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

	private keyAction(keybinding: Keybinding, action: string): string {
		const label = configuredKeyLabel(keybinding, { keybindings: this.keybindings });
		return label ? `${label} ${action}` : "";
	}

	private keyGroupAction(bindings: Keybinding[], action: string): string {
		const labels = bindings
			.map((binding) => configuredKeyLabel(binding, { keybindings: this.keybindings }))
			.filter(Boolean)
			.join("/");
		return labels ? `${labels} ${action}` : "";
	}

	private previewLines(previewText: string, width: number): string[] {
		return this.previews.get(previewText, width, () =>
			new Markdown(previewText, 1, 0, getMarkdownTheme()).render(Math.max(1, width)),
		);
	}

	private renderTabs(snapshot: DialogSnapshot, renderWidth: number, lines: string[]): void {
		const { questions, states, current, mode } = snapshot;
		const theme = this.theme;
		if (questions.length < 2) return;
		const tabCount = questions.length + 1;
		const headerWidth = Math.max(4, Math.floor((renderWidth - tabCount * 5) / tabCount));
		const reviewing = mode.kind === "review";
		const tabs = [
			...questions.map((question, index) => {
				const answered = hasAnswer(states[index]);
				const label = ` ${answered ? "■" : "□"} ${truncateToWidth(question.header, headerWidth)} `;
				if (!reviewing && index === current) {
					return theme.bg("selectedBg", theme.fg(answered ? "success" : "text", label));
				}
				return theme.fg(answered ? "success" : "muted", label);
			}),
			reviewing
				? theme.bg("selectedBg", theme.fg("text", " ✓ Submit "))
				: theme.fg(firstUnanswered(states) === undefined ? "success" : "dim", " ✓ Submit "),
		].join(" ");
		wrapWithPrefix(" ", tabs, renderWidth, lines);
	}

	private renderReview(snapshot: DialogSnapshot, renderWidth: number, lines: string[]): void {
		const theme = this.theme;
		wrapWithPrefix(" ", theme.fg("accent", "Review answers"), renderWidth, lines);
		lines.push("");
		for (const answer of orderedAnswers(snapshot.questions, snapshot.states)) {
			wrapWithPrefix(" ", theme.fg("text", `${answer.questionIndex + 1}. ${answer.question}`), renderWidth, lines);
			wrapWithPrefix("    ", theme.fg("success", answerScalar(answer)), renderWidth, lines);
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
					this.keyAction("tui.select.confirm", "submit"),
					this.keyAction("tui.select.cancel", "edit last question"),
					this.keyGroupAction(["tui.select.up", "tui.select.down"], "scroll"),
				),
			),
			renderWidth,
			lines,
		);
	}

	/** Chat row, warning, and key hints: always visible below the scrolling option area. */
	private renderFooter(snapshot: DialogSnapshot, renderWidth: number, digitRange: string): string[] {
		const theme = this.theme;
		const { mode } = snapshot;
		const state = snapshot.states[snapshot.current];
		const isMulti = state.draft.kind === "multi";
		const chat = mode.kind === "chat";
		const lines: string[] = [];
		wrapWithPrefix(
			`${chat ? theme.fg("accent", "→") : " "} `,
			theme.fg(chat ? "accent" : "text", "Chat about this"),
			renderWidth,
			lines,
		);
		if (state.warning) {
			lines.push("");
			wrapWithPrefix(" ", theme.fg("warning", state.warning), renderWidth, lines);
		}
		// Editor reads the global TUI manager internally, while dialog controls use the injected manager.
		const submitLabel = configuredKeyLabel("tui.input.submit");
		const editorSubmit = (action: string) => (submitLabel ? `${submitLabel} ${action}` : "");
		const questionsHint =
			snapshot.questions.length > 1
				? this.keyGroupAction(["tui.editor.cursorLeft", "tui.editor.cursorRight"], "questions")
				: "";
		let hints: string;
		if (mode.kind === "notes") {
			hints = joinHints(editorSubmit("save notes"), this.keyAction("tui.select.cancel", "back"));
		} else if (mode.kind === "custom") {
			hints = joinHints(
				editorSubmit(isMulti ? "save custom answer" : "continue"),
				this.keyAction("tui.select.cancel", "back"),
			);
		} else if (chat) {
			hints = joinHints(
				this.keyAction("tui.select.confirm", "discuss"),
				this.keyAction("tui.select.up", "return to options"),
				this.keyAction("tui.select.cancel", "cancel"),
			);
		} else {
			hints = joinHints(
				this.keyGroupAction(["tui.select.up", "tui.select.down"], "navigate"),
				`${digitRange} ${isMulti ? "toggle" : "select"}`,
				isMulti ? this.keyAction("app.list.toggle", "toggle focused") : "",
				this.keyAction("tui.input.tab", "notes/custom"),
				this.keyAction("tui.select.confirm", isMulti ? "continue" : "select"),
				questionsHint,
				this.keyAction("tui.select.cancel", "cancel"),
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
	private windowOptionLines(
		optionLines: string[],
		items: WindowItem[],
		focus: number,
		rows: number,
		width: number,
	): { rows: string[]; focusRow: number } {
		const theme = this.theme;
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
}
