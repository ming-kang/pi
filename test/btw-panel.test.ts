import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { BtwTurn } from "../src/extensions/btw/agent.ts";
import { BtwPanel, type BtwPanelState } from "../src/extensions/btw/panel.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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
	const state: BtwPanelState = {
		phase: "ready",
		busy: turns.some((turn) => turn.status === "streaming"),
		turns,
		blockedTools: 0,
	};
	const panel = new BtwPanel(
		{ terminal, requestRender },
		() => theme,
		() => state,
	);
	return { panel, state, requestRender };
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

	it("bounds Chinese, emoji, long tokens and code to the available width and a third of the screen", () => {
		const fixture = panelFixture([
			turn({
				status: "done",
				question: "中文问题🙂".repeat(10),
				answer: `# 中文标题\n\n${"hello🙂中文".repeat(200)}\n\n\`\`\`ts\n${"const answer = '很长的代码';\n".repeat(20)}\`\`\``,
			}),
		]);
		for (const width of [1, 5, 12, 35, 80, 120]) {
			const lines = fixture.panel.render(width);
			expect(lines.length).toBeLessThanOrEqual(10);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		fixture.panel.dispose();
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

	it("refreshes only while answering and releases timers and content on disposal", () => {
		vi.useFakeTimers();
		const fixture = panelFixture([turn()]);
		fixture.panel.changed();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(450);
		expect(fixture.requestRender.mock.calls.length).toBeGreaterThan(1);
		fixture.state.busy = false;
		fixture.panel.changed();
		expect(vi.getTimerCount()).toBe(0);
		fixture.state.busy = true;
		fixture.panel.changed();
		fixture.panel.dispose();
		expect(vi.getTimerCount()).toBe(0);
		expect(fixture.panel.render(80)).toEqual([]);
	});

	it("uses statusline token units and the latest request cache rate, hiding zero usage and cost", () => {
		const fixture = panelFixture([turn({ status: "done", answer: "ok" })]);
		fixture.state.usage = {
			...btwResponse("").usage,
			input: 37500,
			output: 1800,
			cacheRead: 28500,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		fixture.state.latestCacheHitPercent = 57.25;
		const footer = stripTerminalSequences(fixture.panel.render(160).at(-1)!);
		expect(footer).toContain("↑38k ↓1.8k R29k CH57.3%");
		expect(footer).not.toContain("W0");
		expect(footer).not.toContain("$");
		fixture.state.usage.cost.total = 0.1234;
		fixture.state.usesSubscription = true;
		expect(stripTerminalSequences(fixture.panel.render(160).at(-1)!)).toContain("$0.123 (sub)");
		fixture.panel.dispose();
	});

	it.each([0, 23])("formats capture time in 24-hour HH:MM:SS form at hour %s", (hour) => {
		const fixture = panelFixture([]);
		fixture.state.capturedAt = new Date(2026, 8, 7, hour, 31, 4).getTime();
		const output = stripTerminalSequences(fixture.panel.render(120).join("\n"));
		expect(output).toContain(`Context at ${String(hour).padStart(2, "0")}:31:04`);
		fixture.panel.dispose();
	});
});
