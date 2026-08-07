import { Text, TuiMainScreen } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescingTerminal } from "../src/utils/coalescing-terminal.ts";

const COLS = 40;
const ROWS = 10;

class SizedTerminal extends CoalescingTerminal {
	override get columns(): number {
		return COLS;
	}
	override get rows(): number {
		return ROWS;
	}
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function writeToXterm(term: InstanceType<typeof xterm.Terminal>, data: string): Promise<void> {
	return new Promise((resolve) => term.write(data, resolve));
}

describe("CoalescingTerminal scrollback preservation (e2e)", () => {
	let captured: string[];
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		captured = [];
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((data: string | Uint8Array) => {
			captured.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	it("keeps scrollback and screen state consistent across a content-driven full redraw", async () => {
		const emulator = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
		// Seed "shell history" to simulate content already in the terminal
		// before pi starts.
		for (let i = 0; i < 5; i++) {
			await writeToXterm(emulator, `shell-history-${i}\r\n`);
		}

		const terminal = new SizedTerminal();
		// Simulate an agent run in progress (interactive mode opens the
		// preservation window at agent_start).
		terminal.setAgentRunActive(true);
		const tui = new TuiMainScreen(terminal, false);
		const texts: InstanceType<typeof Text>[] = [];
		for (let i = 0; i < 30; i++) {
			const t = new Text(`line ${i}`, 0, 0);
			texts.push(t);
			tui.addChild(t);
		}
		tui.start();
		await wait(50);

		// 1) Trigger a content-driven full redraw: change a line above the
		// viewport (30 lines, viewport = the last 10).
		texts[5].setText("line 5 CHANGED");
		tui.requestRender();
		await wait(50);

		// 2) Repeated full redraws must not grow the buffer without bound
		// (the Ctrl+O expansion + streaming scenario).
		for (let k = 0; k < 5; k++) {
			texts[6 + k].setText(`line ${6 + k} CHANGED ${k}`);
			tui.requestRender();
			await wait(40);
		}

		// 3) Differential renders afterwards must still land on the right
		// coordinates: change a line inside the viewport + append one.
		texts[25].setText("line 25 UPDATED");
		tui.requestRender();
		await wait(50);
		tui.addChild(new Text("line 30 appended", 0, 0));
		tui.requestRender();
		await wait(50);

		const output = captured.join("");
		tui.stop();

		// Assertion A: the output stream contains neither the
		// scrollback-clearing 3J nor ED 2 (conhost/Windows Terminal implement
		// 2J by pushing the screen into scrollback, so without the 3J wipe
		// every redraw would stack another screenful of duplicates).
		expect(output).not.toContain("\x1b[3J");
		expect(output).not.toContain("\x1b[2J");
		// Confirm full redraws actually happened (otherwise the scenario is void).
		expect(tui.fullRedraws).toBeGreaterThanOrEqual(6);

		// Replay into the xterm emulator.
		await writeToXterm(emulator, output);

		// Assertion B: the seeded shell history is still in the buffer.
		const buf = emulator.buffer.active;
		const all: string[] = [];
		for (let i = 0; i < buf.length; i++) {
			all.push(buf.getLine(i)?.translateToString(true) ?? "");
		}
		const joined = all.join("\n");
		for (let i = 0; i < 5; i++) {
			expect(joined).toContain(`shell-history-${i}`);
		}

		// Assertion C: the final visible screen matches what the TUI believes
		// it rendered (the upstream-semantics final screen state).
		const contentLines = (tui as unknown as { previousLines: string[] }).previousLines;
		const expected = contentLines.slice(-ROWS).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, ""));
		const viewportStart = buf.length - ROWS;
		const screen: string[] = [];
		for (let i = 0; i < ROWS; i++) {
			screen.push(buf.getLine(viewportStart + i)?.translateToString(true) ?? "");
		}
		expect(screen.map((s) => s.trimEnd())).toEqual(expected.map((s) => s.trimEnd()));
		// The changes actually landed on screen.
		expect(screen.join("\n")).toContain("line 25 UPDATED");
		expect(screen.join("\n")).toContain("line 30 appended");

		// Assertion D: the buffer stays bounded — 5 lines of shell history +
		// 31 content lines + a small margin; repeated full redraws must not
		// stack duplicate copies.
		expect(buf.length).toBeLessThanOrEqual(5 + 31 + ROWS);
	});

	it("keeps every line reachable when a full redraw grows the transcript (Ctrl+O expansion)", async () => {
		const emulator = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
		for (let i = 0; i < 3; i++) {
			await writeToXterm(emulator, `shell-history-${i}\r\n`);
		}

		const terminal = new SizedTerminal();
		// Simulate an agent run in progress (interactive mode opens the
		// preservation window at agent_start).
		terminal.setAgentRunActive(true);
		const tui = new TuiMainScreen(terminal, false);
		// Same wiring as interactive mode: read which transcript line the top
		// screen row sits at through the public captureRenderState() (pi-tui
		// writes the frame before updating its bookkeeping, so this observes
		// the pre-frame value).
		terminal.setViewportTopProvider(() => tui.captureRenderState().previousViewportTop);
		const texts: InstanceType<typeof Text>[] = [];
		for (let i = 0; i < 30; i++) {
			const t = new Text(`line ${i}`, 0, 0);
			texts.push(t);
			tui.addChild(t);
		}
		tui.start();
		await wait(50);

		// Simulate Ctrl+O: expansion is a global toggle — a line above the
		// viewport changes too (e.g. an earlier card's hint line), forcing
		// pi-tui down the fullRender path; meanwhile a card inside the
		// viewport (line 22 of 30, viewport = 20..29) grows by 15 lines,
		// pushing its own header past the top edge of the screen. Regression
		// scenario: those header lines used to land neither on screen nor in
		// scrollback — they simply vanished.
		texts[5].setText("line 5 (toggled)");
		const details = Array.from({ length: 15 }, (_, k) => `DETAIL-${k}`);
		texts[22].setText(["line 22 EXPANDED", ...details].join("\n"));
		tui.requestRender();
		await wait(50);

		const output = captured.join("");
		tui.stop();

		// Redraws must not clear scrollback.
		expect(output).not.toContain("\x1b[3J");
		expect(output).not.toContain("\x1b[2J");
		expect(tui.fullRedraws).toBeGreaterThanOrEqual(2);

		await writeToXterm(emulator, output);
		const buf = emulator.buffer.active;
		const all: string[] = [];
		for (let i = 0; i < buf.length; i++) {
			all.push(buf.getLine(i)?.translateToString(true) ?? "");
		}
		const joined = all.join("\n");

		// The shell history is still there.
		for (let i = 0; i < 3; i++) {
			expect(joined).toContain(`shell-history-${i}`);
		}
		// Every expanded line must be reachable (on screen or in scrollback),
		// including the header pushed past the top of the screen.
		expect(joined).toContain("line 22 EXPANDED");
		for (const detail of details) {
			expect(joined).toContain(detail);
		}
		// Accepted trade-off: the change that sits above the screen, deep in
		// scrollback, keeps its old rendering (scrollback cannot be
		// rewritten) — but the content survives instead of vanishing.
		expect(joined).not.toContain("line 5 (toggled)");
		expect(joined).toContain("line 5");
		// The final visible screen matches the upstream-semantics final state
		// (the last ROWS lines of the transcript).
		const contentLines = (tui as unknown as { previousLines: string[] }).previousLines;
		const expected = contentLines.slice(-ROWS).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, ""));
		const viewportStart = buf.length - ROWS;
		const screen: string[] = [];
		for (let i = 0; i < ROWS; i++) {
			screen.push(buf.getLine(viewportStart + i)?.translateToString(true) ?? "");
		}
		expect(screen.map((s) => s.trimEnd())).toEqual(expected.map((s) => s.trimEnd()));
		// Bounded buffer: 3 lines of shell history + 45 lines of new
		// transcript + margin, with no duplicate copies.
		expect(buf.length).toBeLessThanOrEqual(3 + 45 + ROWS);
	});
});
