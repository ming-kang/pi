import "./keybindings.ts";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type Component,
	Markdown,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { keyLabel } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { BtwTurn } from "./agent.ts";

export interface BtwPanelState {
	phase: "opening" | "ready" | "error";
	error?: string;
	capturedAt?: number;
	model?: string;
	busy: boolean;
	turns: readonly BtwTurn[];
	usage?: Usage;
	latestCacheHitPercent?: number;
	usesSubscription?: boolean;
	blockedTools: number;
}

function tokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** A bounded, scrollable widget above the normal editor. It never takes keyboard focus. */
export class BtwPanel implements Component {
	private readonly tui: Pick<TUI, "terminal" | "requestRender">;
	private readonly getTheme: () => Theme;
	private readonly getState: () => BtwPanelState;
	private readonly answers = new Map<BtwTurn, Markdown>();
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
		if (this.getState().busy && !this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.changed();
			}, 150);
			this.timer.unref?.();
		} else if (!this.getState().busy && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	followTail(): void {
		this.follow = true;
		this.changed();
	}

	scroll(delta: number): boolean {
		if (this.maxOffset === 0) return false;
		this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
		this.follow = this.offset === this.maxOffset;
		this.tui.requestRender();
		return true;
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
		const theme = this.getTheme();
		const innerWidth = Math.max(1, width - 4);
		const lines = this.body(state, innerWidth, theme);
		const cap = Math.max(1, Math.floor(this.tui.terminal.rows / 3) - 2);
		const needed = Math.min(cap, Math.max(1, lines.length));
		this.heldHeight = state.busy ? Math.min(cap, Math.max(this.heldHeight, needed)) : needed;
		this.maxOffset = Math.max(0, lines.length - this.heldHeight);
		this.offset = this.follow ? this.maxOffset : Math.min(this.offset, this.maxOffset);
		const body = lines.slice(this.offset, this.offset + this.heldHeight);
		while (body.length < this.heldHeight) body.push("");
		const close = keyLabel("app.btw.close");
		const cancel = keyLabel("app.btw.cancel");
		const title = [
			theme.fg("accent", theme.bold("BTW")),
			close && theme.fg("text", close) + theme.fg("muted", " close"),
			state.busy && cancel && theme.fg("text", cancel) + theme.fg("muted", " stop"),
		]
			.filter(Boolean)
			.join(theme.fg("muted", " · "));
		const footer = this.footer(state, theme);
		if (width < 6) return body.map((line) => truncateToWidth(line, width));
		return [
			this.border(title, width, true, theme),
			...body.map(
				(line) =>
					theme.fg("borderAccent", "│ ") +
					truncateToWidth(line, innerWidth, "…", true) +
					theme.fg("borderAccent", " │"),
			),
			this.border(footer, width, false, theme),
		];
	}

	private body(state: BtwPanelState, width: number, theme: Theme): string[] {
		if (state.phase === "opening") return [theme.fg("muted", "Capturing context…")];
		if (state.phase === "error")
			return new Text(theme.fg("error", state.error ?? "Could not open BTW."), 0, 0).render(width);
		if (!state.turns.length) {
			return [
				...new Text(theme.fg("text", "Ask a side question in the editor below."), 0, 0).render(width),
				...new Text(
					theme.fg(
						"muted",
						`Context at ${new Date(state.capturedAt ?? Date.now()).toTimeString().slice(0, 8)} · ${state.model ?? ""}`,
					),
					0,
					0,
				).render(width),
			];
		}
		const lines: string[] = [];
		for (const [index, turn] of state.turns.entries()) {
			if (index > 0) lines.push("");
			lines.push(
				...new Text(
					theme.fg("accent", theme.bold(`Q${index + 1}: `)) + theme.fg("text", turn.question),
					0,
					0,
				).render(width),
			);
			if (turn.answer) {
				let markdown = this.answers.get(turn);
				if (!markdown) {
					markdown = new Markdown(turn.answer, 0, 0, getMarkdownTheme(), {
						color: (text) => theme.fg("text", text),
					});
					this.answers.set(turn, markdown);
				} else markdown.setText(turn.answer);
				lines.push(...markdown.render(width));
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

	private footer(state: BtwPanelState, theme: Theme): string {
		const parts: string[] = [];
		const label = (text: string) => theme.fg("muted", text);
		const value = (text: string) => theme.fg("text", text);
		if (this.maxOffset > 0) {
			const keys = [keyLabel("app.btw.scrollUp"), keyLabel("app.btw.scrollDown")].filter(Boolean).join("/");
			parts.push(
				value(keys) +
					label(" scroll ") +
					value(`${this.offset + 1}–${this.offset + this.heldHeight}/${this.maxOffset + this.heldHeight}`),
			);
		}
		const usage = state.usage;
		if (usage) {
			const stats: string[] = [];
			if (usage.input > 0) stats.push(`↑${tokens(usage.input)}`);
			if (usage.output > 0) stats.push(`↓${tokens(usage.output)}`);
			if (usage.cacheRead > 0) stats.push(`R${tokens(usage.cacheRead)}`);
			if (usage.cacheWrite > 0) stats.push(`W${tokens(usage.cacheWrite)}`);
			if (state.latestCacheHitPercent !== undefined) stats.push(`CH${state.latestCacheHitPercent.toFixed(1)}%`);
			if (usage.cost.total > 0)
				stats.push(`$${usage.cost.total.toFixed(3)}${state.usesSubscription ? " (sub)" : ""}`);
			if (stats.length) parts.push(value(stats.join(" ")));
		}
		if (state.blockedTools) parts.push(value(String(state.blockedTools)) + label(" tools blocked"));
		const turn = state.turns.at(-1);
		if (turn && !state.busy) {
			parts.push(value(`${(turn.elapsedMs / 1000).toFixed(1)}s`));
			if (turn.firstAnswerMs !== undefined)
				parts.push(label("first ") + value(`${(turn.firstAnswerMs / 1000).toFixed(1)}s`));
		}
		return parts.join(label(" · "));
	}

	private border(label: string, width: number, top: boolean, theme: Theme): string {
		const text = label ? ` ${truncateToWidth(label, Math.max(0, width - 4))} ` : "";
		return (
			theme.fg("borderAccent", top ? "╭" : "╰") +
			text +
			theme.fg("borderAccent", `${"─".repeat(Math.max(0, width - visibleWidth(text) - 2))}${top ? "╮" : "╯"}`)
		);
	}
}
