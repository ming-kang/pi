import "./keybindings.ts";
import {
	type Component,
	Markdown,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import { formatTokens } from "../../utils/number.ts";
import type { BtwConversationState, BtwTurn } from "./agent.ts";

export type BtwPanelState<Conversation extends BtwConversationState = Readonly<BtwConversationState>> =
	| { phase: "opening" }
	| { phase: "error"; error: string }
	| {
			phase: "ready";
			capturedAt: number;
			model: string;
			conversation: Conversation;
	  };

/** A bounded, scrollable widget above the normal editor. It never takes keyboard focus. */
export class BtwPanel implements Component {
	private readonly tui: Pick<TUI, "terminal" | "requestRender">;
	private readonly getTheme: () => Theme;
	private readonly getState: () => BtwPanelState;
	private readonly answers = new Map<BtwTurn, { text: string; markdown: Markdown }>();
	private follow = true;
	private offset = 0;
	private maxOffset = 0;
	private heldHeight = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(tui: Pick<TUI, "terminal" | "requestRender">, getTheme: () => Theme, getState: () => BtwPanelState) {
		this.tui = tui;
		this.getTheme = getTheme;
		this.getState = getState;
	}

	invalidate(): void {
		this.answers.clear();
	}

	changed(): void {
		if (this.disposed) return;
		this.tui.requestRender();
		const state = this.getState();
		const busy = state.phase === "ready" && state.conversation.busy;
		if (busy && !this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.changed();
			}, 150);
			this.timer.unref?.();
		} else if (!busy && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	followTail(): void {
		this.follow = true;
		this.changed();
	}

	scroll(delta: number): boolean {
		const next = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
		const moved = next !== this.offset;
		this.offset = next;
		this.follow = next === this.maxOffset;
		if (!moved) return false;
		this.tui.requestRender();
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.type !== "wheel" || !event.wheelDelta) return undefined;
		const moved = this.scroll(event.wheelDelta);
		return { handled: true, render: moved };
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.answers.clear();
	}

	render(width: number): string[] {
		if (this.disposed || width < 1) return [];
		const state = this.getState();
		const busy = state.phase === "ready" && state.conversation.busy;
		const theme = this.getTheme();
		const innerWidth = Math.max(1, width - 4);
		const lines = this.body(state, innerWidth, theme);
		const targetTotal = Math.floor(this.tui.terminal.rows / 2);
		const safeTotal = Math.max(3, Math.min(targetTotal, this.tui.terminal.rows - 7));
		const cap = Math.max(1, safeTotal - 2);
		const needed = Math.min(cap, Math.max(1, lines.length));
		this.heldHeight = busy ? Math.min(cap, Math.max(this.heldHeight, needed)) : needed;
		this.maxOffset = Math.max(0, lines.length - this.heldHeight);
		this.offset = this.follow ? this.maxOffset : Math.min(this.offset, this.maxOffset);
		this.follow = this.offset === this.maxOffset;
		const body = lines.slice(this.offset, this.offset + this.heldHeight);
		while (body.length < this.heldHeight) body.push("");
		const close = keyLabel("app.btw.close");
		const cancel = keyLabel("app.btw.cancel");
		const title = [
			theme.fg("accent", theme.bold("BTW")),
			close && theme.fg("text", close) + theme.fg("muted", " close"),
			busy && cancel && theme.fg("text", cancel) + theme.fg("muted", " stop"),
		]
			.filter(Boolean)
			.join(theme.fg("muted", " · "));
		const meta = this.headerRight(state, theme);
		if (width < 6) return body.map((line) => truncateToWidth(line, width));
		return [
			this.topBorder(title, meta, width, theme),
			...body.map(
				(line) =>
					theme.fg("borderAccent", "│ ") +
					truncateToWidth(line, innerWidth, "…", true) +
					theme.fg("borderAccent", " │"),
			),
			this.bottomBorder(width, theme),
		];
	}

	private body(state: BtwPanelState, width: number, theme: Theme): string[] {
		if (state.phase === "opening") return [theme.fg("muted", "Capturing context…")];
		if (state.phase === "error") return new Text(theme.fg("error", state.error), 0, 0).render(width);
		if (!state.conversation.turns.length) {
			return [
				...new Text(theme.fg("text", "Ask a side question in the editor below."), 0, 0).render(width),
				...new Text(
					theme.fg(
						"muted",
						`Context at ${new Date(state.capturedAt).toTimeString().slice(0, 8)} · ${state.model}`,
					),
					0,
					0,
				).render(width),
			];
		}
		const lines: string[] = [];
		for (const [index, turn] of state.conversation.turns.entries()) {
			if (index > 0) lines.push("");
			lines.push(
				...new Text(
					theme.fg("accent", theme.bold(`Q${index + 1}: `)) + theme.fg("text", turn.question),
					0,
					0,
				).render(width),
			);
			if (turn.answer) {
				let answer = this.answers.get(turn);
				if (!answer) {
					answer = {
						text: turn.answer,
						markdown: new Markdown(turn.answer, 0, 0, getMarkdownTheme(), {
							color: (text) => theme.fg("text", text),
						}),
					};
					this.answers.set(turn, answer);
				} else if (answer.text !== turn.answer) {
					answer.text = turn.answer;
					answer.markdown.setText(turn.answer);
				}
				lines.push(...answer.markdown.render(width));
			} else if (turn.thinking && (turn.status === "streaming" || turn.status === "cancelling")) {
				lines.push(...wrapTextWithAnsi(theme.fg("muted", turn.thinking.trimEnd()), width).slice(-2));
			}
			if (turn.status === "streaming" || turn.status === "cancelling") {
				const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1);
				lines.push(theme.fg("muted", `${turn.status === "cancelling" ? "Stopping" : "Answering"}… ${elapsed}s`));
			}
			if (turn.notice)
				lines.push(
					...new Text(theme.fg(turn.status === "error" ? "error" : "muted", turn.notice), 0, 0).render(width),
				);
		}
		return lines;
	}

	private headerRight(state: BtwPanelState, theme: Theme): string {
		const parts: string[] = [];
		const value = (text: string) => theme.fg("text", text);
		if (this.maxOffset > 0) {
			parts.push(value(`${this.offset + 1}–${this.offset + this.heldHeight}/${this.maxOffset + this.heldHeight}`));
		}
		if (state.phase === "ready") {
			const { conversation } = state;
			if (conversation.usage.output > 0) parts.push(value(`↓${formatTokens(conversation.usage.output)}`));
			const turn = conversation.turns.at(-1);
			if (turn && !conversation.busy) parts.push(value(`${(turn.elapsedMs / 1000).toFixed(1)}s`));
		}
		return parts.join(theme.fg("muted", " · "));
	}

	private topBorder(left: string, right: string, width: number, theme: Theme): string {
		const inner = Math.max(0, width - 2);
		const border = (text: string) => theme.fg("borderAccent", text);
		if (!right) {
			const leftText = left ? ` ${truncateToWidth(left, Math.max(0, width - 4), "…")} ` : "";
			return border("╭") + leftText + border(`${"─".repeat(Math.max(0, inner - visibleWidth(leftText)))}╮`);
		}
		const leftText = left ? ` ${left} ` : "";
		const rightText = ` ${right} `;
		const leftWidth = visibleWidth(leftText);
		const rightWidth = visibleWidth(rightText);
		if (leftWidth + 1 + rightWidth <= inner) {
			const fill = inner - leftWidth - rightWidth;
			return border("╭") + leftText + border("─".repeat(fill)) + rightText + border("╮");
		}
		const maxRightLabel = inner - leftWidth - 3;
		if (maxRightLabel >= 3) {
			const clippedRight = ` ${truncateToWidth(right, maxRightLabel, "…")} `;
			const fill = Math.max(1, inner - leftWidth - visibleWidth(clippedRight));
			return border("╭") + leftText + border("─".repeat(fill)) + clippedRight + border("╮");
		}
		const clippedLeft = left ? ` ${truncateToWidth(left, Math.max(0, width - 4), "…")} ` : "";
		return border("╭") + clippedLeft + border(`${"─".repeat(Math.max(0, inner - visibleWidth(clippedLeft)))}╮`);
	}

	private bottomBorder(width: number, theme: Theme): string {
		return theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}
}
