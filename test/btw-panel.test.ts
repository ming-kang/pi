import {
	Container,
	getKeybindings,
	Spacer,
	setKeybindings,
	stripTerminalSequences,
	Text,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { BtwConversationState, BtwTurn } from "../src/extensions/btw/agent.ts";
import { BtwPanel, type BtwPanelState } from "../src/extensions/btw/panel.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { TranscriptLayoutContainer } from "../src/modes/interactive/transcript-layout.ts";
import { btwResponse } from "./helpers/btw.ts";
import { VirtualTerminal } from "./helpers/virtual-terminal.ts";

function turn(overrides: Partial<BtwTurn> = {}): BtwTurn {
	return {
		question: "Why?",
		answer: "",
		thinking: "",
		status: "streaming",
		startedAt: Date.now(),
		elapsedMs: 0,
		...overrides,
	};
}

function panelFixture(turns: BtwTurn[], rows = 30) {
	const terminal = new VirtualTerminal(120, rows);
	const requestRender = vi.fn();
	const conversation: BtwConversationState = {
		busy: turns.some((turn) => turn.status === "streaming"),
		turns,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const state: BtwPanelState = {
		phase: "ready",
		capturedAt: Date.now(),
		model: "test/model",
		conversation,
	};
	const panel = new BtwPanel(
		{ terminal, requestRender },
		() => theme,
		() => state,
	);
	return { panel, state, conversation, requestRender };
}

describe("BTW panel", () => {
	const originalKeys = getKeybindings();
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		setKeybindings(originalKeys);
		vi.useRealTimers();
	});

	it("bounds Chinese, emoji, long tokens and code to the available width and half of the screen", () => {
		const fixture = panelFixture([
			turn({
				status: "done",
				question: "中文问题🙂".repeat(10),
				answer: `# 中文标题\n\n${"hello🙂中文".repeat(200)}\n\n\`\`\`ts\n${"const answer = '很长的代码';\n".repeat(20)}\`\`\``,
			}),
		]);
		for (const width of [1, 5, 12, 35, 80, 120]) {
			const lines = fixture.panel.render(width);
			expect(lines.length).toBeLessThanOrEqual(15);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		fixture.panel.dispose();

		const shortTerminal = panelFixture(
			[turn({ status: "done", answer: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n\n") })],
			12,
		);
		expect(shortTerminal.panel.render(80).length).toBeLessThanOrEqual(5);
		shortTerminal.panel.dispose();
	});

	it("holds its streaming height when a two-line thinking preview becomes a short answer", () => {
		const response = turn({ thinking: "thinking one\nthinking two\nthinking three\nthinking four\n" });
		const fixture = panelFixture([response]);
		const initial = fixture.panel.render(80).map(stripTerminalSequences);
		expect(initial.join("\n")).not.toContain("thinking one");
		expect(initial.join("\n")).toContain("thinking three");
		expect(initial.join("\n")).toContain("thinking four");
		response.answer = "Done";
		const next = fixture.panel.render(80).map(stripTerminalSequences);
		expect(next).toHaveLength(initial.length);
		expect(next.join("\n")).not.toContain("thinking four");
		fixture.panel.dispose();
	});

	it("stops tail following while scrolled up and resumes it at the bottom", () => {
		const response = turn({ answer: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n") });
		const fixture = panelFixture([response]);
		expect(fixture.panel.render(80).join("\n")).toContain("line 60");
		expect(fixture.panel.scroll(-8)).toBe(true);
		const older = fixture.panel.render(80).slice(1, -1).map(stripTerminalSequences);
		response.answer += "\n\nNEWEST LINE";
		expect(fixture.panel.render(80).slice(1, -1).map(stripTerminalSequences)).toEqual(older);
		fixture.panel.scroll(1000);
		expect(fixture.panel.render(80).join("\n")).toContain("NEWEST LINE");
		fixture.panel.dispose();
	});

	it("resumes tail following after shrinking content clamps a scrolled panel to its bottom", () => {
		const response = turn({
			status: "done",
			answer: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n"),
		});
		const fixture = panelFixture([response]);
		fixture.panel.render(80);
		fixture.panel.scroll(-20);

		response.answer = Array.from({ length: 16 }, (_, i) => `short ${i + 1}`).join("\n\n");
		expect(fixture.panel.render(80).join("\n")).toContain("short 16");
		expect(fixture.panel.scroll(3)).toBe(false);

		response.answer += "\n\nNEWEST AFTER BOUNDARY SCROLL";
		expect(fixture.panel.render(80).join("\n")).toContain("NEWEST AFTER BOUNDARY SCROLL");
		fixture.panel.dispose();
	});

	it("refreshes only while answering and releases timers and content on disposal", () => {
		vi.useFakeTimers();
		const fixture = panelFixture([turn()]);
		fixture.panel.changed();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(450);
		expect(fixture.requestRender.mock.calls.length).toBeGreaterThan(1);
		fixture.conversation.busy = false;
		fixture.panel.changed();
		expect(vi.getTimerCount()).toBe(0);
		fixture.conversation.busy = true;
		fixture.panel.changed();
		fixture.panel.dispose();
		expect(vi.getTimerCount()).toBe(0);
		expect(fixture.panel.render(80)).toEqual([]);
	});

	it("renders simplified scroll range, output tokens, and elapsed time on the top-right border with a clean bottom border", () => {
		const response = turn({
			status: "done",
			elapsedMs: 2340,
			answer: Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n\n"),
		});
		const fixture = panelFixture([response]);
		fixture.conversation.usage = {
			...btwResponse("").usage,
			input: 37500,
			output: 1800,
			cacheRead: 28500,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1234 },
		};
		fixture.panel.render(160);
		fixture.panel.scroll(-10);
		const lines = fixture.panel.render(160).map(stripTerminalSequences);
		const top = lines[0]!;
		const bottom = lines.at(-1)!;
		expect(top).toContain("BTW");
		expect(top).toMatch(/\d+–\d+\/\d+ · ↓1\.8k · 2\.3s ╮$/);
		expect(top).not.toContain("↑");
		expect(top).not.toContain("scroll");
		expect(top).not.toContain("$");
		expect(bottom).toMatch(/^╰─+╯$/);
		expect(visibleWidth(top)).toBe(160);
		expect(visibleWidth(bottom)).toBe(160);

		const shortFixture = panelFixture([turn({ status: "done", elapsedMs: 900, answer: "ok" })]);
		const shortTop = stripTerminalSequences(shortFixture.panel.render(120)[0]!);
		expect(shortTop).toMatch(/0\.9s ╮$/);
		expect(shortTop).not.toContain("/");
		fixture.panel.dispose();
		shortFixture.panel.dispose();
	});

	it("handles wheel scrolling inside the panel without stealing focus or leaking boundaries", () => {
		const response = turn({ answer: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n") });
		const fixture = panelFixture([response]);
		fixture.panel.render(80);

		const wheelUp = fixture.panel.handleMouse({
			type: "wheel",
			button: "none",
			x: 10,
			y: 3,
			screenX: 10,
			screenY: 15,
			width: 80,
			height: 15,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: -5,
		});
		expect(wheelUp).toEqual({ handled: true, render: true });
		expect(fixture.panel.render(80).join("\n")).not.toContain("line 60");

		// Scrolling past the bottom edge is contained without forcing a redundant re-render.
		fixture.panel.scroll(1000);
		const atBottom = fixture.panel.handleMouse({
			type: "wheel",
			button: "none",
			x: 10,
			y: 3,
			screenX: 10,
			screenY: 15,
			width: 80,
			height: 15,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 5,
		});
		expect(atBottom).toEqual({ handled: true, render: false });

		// Non-wheel mouse events pass through so text selection stays available.
		const press = fixture.panel.handleMouse({
			type: "press",
			button: "left",
			x: 10,
			y: 3,
			screenX: 10,
			screenY: 15,
			width: 80,
			height: 15,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(press).toBeUndefined();

		// Even a short, non-scrolling BTW panel isolates wheel events from the main transcript.
		const shortFixture = panelFixture([turn({ answer: "short" })]);
		shortFixture.panel.render(80);
		expect(
			shortFixture.panel.handleMouse({
				type: "wheel",
				button: "none",
				x: 5,
				y: 1,
				screenX: 5,
				screenY: 20,
				width: 80,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta: -3,
			}),
		).toEqual({ handled: true, render: false });

		fixture.panel.dispose();
		shortFixture.panel.dispose();
		expect(
			fixture.panel.handleMouse({
				type: "wheel",
				button: "none",
				x: 10,
				y: 3,
				screenX: 10,
				screenY: 15,
				width: 80,
				height: 15,
				shift: false,
				alt: false,
				ctrl: false,
				wheelDelta: -3,
			}),
		).toBeUndefined();
	});

	it.each([0, 23])("formats capture time in 24-hour HH:MM:SS form at hour %s", (hour) => {
		const fixture = panelFixture([]);
		fixture.state.capturedAt = new Date(2026, 8, 7, hour, 31, 4).getTime();
		const output = stripTerminalSequences(fixture.panel.render(120).join("\n"));
		expect(output).toContain(`Context at ${String(hour).padStart(2, "0")}:31:04`);
		fixture.panel.dispose();
	});

	it("routes fullscreen mouse wheel events to BTW inside the panel and to main transcript outside it", async () => {
		const chat = new TranscriptLayoutContainer();
		const document = new TranscriptLayoutContainer();
		document.addChild(chat);
		chat.addChild(new Text(Array.from({ length: 50 }, (_, i) => `main line ${i + 1}`).join("\n"), 0, 0));
		const widgetsAbove = new Container();
		const editor = new Container();
		editor.addChild(new Text("editor\nline 2\nline 3", 0, 0));
		const footer = new Container();
		footer.addChild(new Text("footer 1\nfooter 2", 0, 0));
		const viewport = createChatViewport({
			document,
			chat,
			pendingMessages: new Container(),
			status: new Container(),
			widgetsAbove,
			editor,
			footer,
			scrollbar: "hidden",
			outputPad: () => 1,
		});
		const terminal = new VirtualTerminal(80, 30);
		const tui = new TuiAltScreen(terminal);
		const btwTurn = turn({
			status: "done",
			elapsedMs: 1200,
			answer: Array.from({ length: 50 }, (_, i) => `btw line ${i + 1}`).join("\n\n"),
		});
		const conversation: BtwConversationState = {
			busy: false,
			turns: [btwTurn],
			usage: btwResponse("").usage,
		};
		const state: BtwPanelState = {
			phase: "ready",
			capturedAt: Date.now(),
			model: "test/model",
			conversation,
		};
		const panel = new BtwPanel(
			tui,
			() => theme,
			() => state,
		);
		widgetsAbove.addChild(new Spacer(1));
		widgetsAbove.addChild(panel);
		tui.setLayoutRoot(viewport.root);
		tui.start();
		try {
			await terminal.waitForRender();
			const mainBottom = viewport.transcript.scrollTop;
			expect(mainBottom).toBeGreaterThan(0);

			const screenBefore = terminal.getViewport();
			const btwTopIdx = screenBefore.findIndex((line) => line.includes("BTW"));
			expect(btwTopIdx).toBeGreaterThan(2);
			expect(screenBefore.join("\n")).toContain("btw line 50");

			// Wheel up inside BTW body (1-based SGR coordinates).
			const btwBodyRow = btwTopIdx + 3;
			terminal.sendInput(`\x1b[<64;10;${btwBodyRow}M`);
			await terminal.waitForRender();

			expect(viewport.transcript.scrollTop).toBe(mainBottom);
			const afterBtwScroll = terminal.getViewport().join("\n");
			expect(afterBtwScroll).not.toContain("btw line 50");

			// Wheel up in the main transcript region above BTW.
			terminal.sendInput("\x1b[<64;10;2M");
			await terminal.waitForRender();
			expect(viewport.transcript.scrollTop).toBeLessThan(mainBottom);
		} finally {
			panel.dispose();
			tui.stop();
		}
	});
});
