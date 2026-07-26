import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescingTerminal } from "../src/utils/coalescing-terminal.ts";

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("CoalescingTerminal", () => {
	let chunks: string[];
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		chunks = [];
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((data: string | Uint8Array) => {
			chunks.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	it("merges writes from one synchronous task into a single stdout write", async () => {
		const terminal = new CoalescingTerminal();
		// Same shape as one pi-tui render pass: frame in a synchronized-output
		// block, then the IME cursor reposition, then the visibility toggle.
		terminal.write("\x1b[?2026h\r\x1b[2Kabc\x1b[?2026l");
		terminal.write("\x1b[3G");
		terminal.hideCursor();
		expect(chunks).toEqual([]);
		await flushMicrotasks();
		expect(chunks).toEqual(["\x1b[?2026h\r\x1b[2Kabc\x1b[?2026l\x1b[3G\x1b[?25l"]);
		terminal.stop();
	});

	it("keeps escape helpers ordered relative to write()", async () => {
		const terminal = new CoalescingTerminal();
		terminal.moveBy(2);
		terminal.write("x");
		terminal.moveBy(-1);
		terminal.showCursor();
		terminal.clearLine();
		terminal.clearFromCursor();
		terminal.clearScreen();
		await flushMicrotasks();
		expect(chunks).toEqual(["\x1b[2Bx\x1b[1A\x1b[?25h\x1b[K\x1b[J\x1b[2J\x1b[H"]);
		terminal.stop();
	});

	it("flushes writes from separate tasks separately", async () => {
		const terminal = new CoalescingTerminal();
		terminal.write("first");
		await flushMicrotasks();
		terminal.write("second");
		await flushMicrotasks();
		expect(chunks).toEqual(["first", "second"]);
		terminal.stop();
	});

	it("flushes pending output before stop() writes teardown sequences", () => {
		const terminal = new CoalescingTerminal();
		terminal.write("pending frame");
		terminal.stop();
		expect(chunks[0]).toBe("pending frame");
		// ProcessTerminal.stop() disables bracketed paste directly on stdout.
		expect(chunks.slice(1).join("")).toContain("\x1b[?2004l");
	});

	it("does not schedule empty flushes", async () => {
		const terminal = new CoalescingTerminal();
		terminal.write("");
		await flushMicrotasks();
		expect(chunks).toEqual([]);
		terminal.stop();
	});
});

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const CLEAR_WITH_SCROLLBACK = "\x1b[2J\x1b[H\x1b[3J";

/** Deterministic dimensions independent of the test process's stdout. */
class SizedTerminal extends CoalescingTerminal {
	cols = 20;
	rowCount = 5;
	override get columns(): number {
		return this.cols;
	}
	override get rows(): number {
		return this.rowCount;
	}
}

function fullRedrawFrame(lines: string[]): string {
	return SYNC_START + CLEAR_WITH_SCROLLBACK + lines.join("\r\n") + SYNC_END;
}

/** Terminal inside the preservation window (agent run active). */
function preserving(): SizedTerminal {
	const terminal = new SizedTerminal();
	terminal.setScrollbackPreservation(true);
	return terminal;
}

describe("CoalescingTerminal scrollback preservation", () => {
	let chunks: string[];
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		chunks = [];
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((data: string | Uint8Array) => {
			chunks.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	it("drops the scrollback wipe and overwrites only the bottom viewport rows in place", async () => {
		const terminal = preserving();
		const lines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
		terminal.write(fullRedrawFrame(lines));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\r\n\x1b[2Kl7\r\n\x1b[2Kl8\x1b[J${SYNC_END}`,
		]);
		terminal.stop();
	});

	it("keeps every line and erases below when the frame is shorter than the viewport", async () => {
		const terminal = preserving();
		terminal.write(fullRedrawFrame(["a", "b", "c"]));
		await flushMicrotasks();
		expect(chunks).toEqual([`${SYNC_START}\x1b[H\x1b[2Ka\r\n\x1b[2Kb\r\n\x1b[2Kc\x1b[J${SYNC_END}`]);
		terminal.stop();
	});

	it("never emits ED 2 in rewritten frames (conhost scrolls it into scrollback)", async () => {
		const terminal = preserving();
		terminal.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]));
		await flushMicrotasks();
		expect(chunks.join("")).not.toContain("\x1b[2J");
		expect(chunks.join("")).not.toContain("\x1b[3J");
		terminal.stop();
	});

	it("keeps the upstream wipe when the terminal width changed", async () => {
		const terminal = preserving();
		terminal.write("prime");
		await flushMicrotasks();
		terminal.cols = 30;
		const frame = fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]);
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks[1]).toBe(frame);
		terminal.stop();
	});

	it("transforms again after the width settles at the new value", async () => {
		const terminal = preserving();
		terminal.write("prime");
		await flushMicrotasks();
		terminal.cols = 30;
		terminal.write(fullRedrawFrame(["w1", "w2"]));
		await flushMicrotasks();
		terminal.write(fullRedrawFrame(["n1", "n2"]));
		await flushMicrotasks();
		expect(chunks[2]).toBe(`${SYNC_START}\x1b[H\x1b[2Kn1\r\n\x1b[2Kn2\x1b[J${SYNC_END}`);
		terminal.stop();
	});

	it("leaves frames containing kitty graphics untouched", async () => {
		const terminal = preserving();
		const frame = `${SYNC_START}\x1b_Ga=d,i=3\x1b\\${CLEAR_WITH_SCROLLBACK}l1\r\nl2${SYNC_END}`;
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("leaves differential render frames untouched", async () => {
		const terminal = preserving();
		const frame = `${SYNC_START}\r\x1b[2Kupdated line${SYNC_END}`;
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("bails out when the frame contains a second clear sequence", async () => {
		const terminal = preserving();
		const frame = `${SYNC_START}${CLEAR_WITH_SCROLLBACK}l1\r\n${CLEAR_WITH_SCROLLBACK}l2${SYNC_END}`;
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("still coalesces the rewritten frame with trailing cursor writes", async () => {
		const terminal = preserving();
		terminal.write(fullRedrawFrame(["a", "b"]));
		terminal.write("\x1b[3G");
		terminal.hideCursor();
		await flushMicrotasks();
		expect(chunks).toEqual([`${SYNC_START}\x1b[H\x1b[2Ka\r\n\x1b[2Kb\x1b[J${SYNC_END}\x1b[3G\x1b[?25l`]);
		terminal.stop();
	});

	it("keeps the upstream wipe when the terminal height changed", async () => {
		const terminal = preserving();
		terminal.write("prime");
		await flushMicrotasks();
		terminal.rowCount = 8;
		const frame = fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]);
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks[1]).toBe(frame);
		terminal.stop();
	});

	it("scrolls grown lines into scrollback when the viewport top is known", async () => {
		const terminal = preserving();
		terminal.setViewportTopProvider(() => 2);
		// Screen (5 rows) previously started at transcript line 2; the new
		// 8-line transcript grew past it by one line. The rewrite must repaint
		// rows 0-4 with lines 2-6 at their existing positions, then let l8
		// scroll in at the bottom so l3 (the repainted top row) enters
		// scrollback bearing new content.
		terminal.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl3\r\n\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\r\n\x1b[2Kl7\r\n\x1b[2Kl8\x1b[J${SYNC_END}`,
		]);
		terminal.stop();
	});

	it("matches the bottom-anchored repaint when the transcript height held steady", async () => {
		const terminal = preserving();
		terminal.setViewportTopProvider(() => 3);
		terminal.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\r\n\x1b[2Kl7\r\n\x1b[2Kl8\x1b[J${SYNC_END}`,
		]);
		terminal.stop();
	});

	it("falls back to the bottom-anchored repaint when the transcript shrank", async () => {
		const terminal = preserving();
		// Screen started at line 5, but the new transcript only reaches
		// viewport top 1; lines cannot be pulled back out of scrollback.
		terminal.setViewportTopProvider(() => 5);
		terminal.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl2\r\n\x1b[2Kl3\r\n\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\x1b[J${SYNC_END}`,
		]);
		terminal.stop();
	});

	it("falls back when the viewport top provider throws or returns garbage", async () => {
		const throwing = preserving();
		throwing.setViewportTopProvider(() => {
			throw new Error("renderer reshaped");
		});
		throwing.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl2\r\n\x1b[2Kl3\r\n\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\x1b[J${SYNC_END}`,
		]);
		throwing.stop();

		chunks.length = 0;
		const garbage = preserving();
		garbage.setViewportTopProvider(() => -1.5 as number);
		garbage.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl2\r\n\x1b[2Kl3\r\n\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\x1b[J${SYNC_END}`,
		]);
		garbage.stop();
	});

	it("passes full redraws through untouched while preservation is off (idle default)", async () => {
		const terminal = new SizedTerminal();
		terminal.setViewportTopProvider(() => 2);
		const frame = fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]);
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("returns to upstream passthrough when preservation is switched back off", async () => {
		const terminal = preserving();
		terminal.write(fullRedrawFrame(["a", "b"]));
		await flushMicrotasks();
		terminal.setScrollbackPreservation(false);
		const frame = fullRedrawFrame(["c", "d"]);
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks[0]).toBe(`${SYNC_START}\x1b[H\x1b[2Ka\r\n\x1b[2Kb\x1b[J${SYNC_END}`);
		expect(chunks[1]).toBe(frame);
		terminal.stop();
	});

	it("lets an armed user toggle keep the upstream wipe mid-preservation", async () => {
		const terminal = preserving();
		terminal.setViewportTopProvider(() => 5);
		terminal.passNextFullRedraw();
		const frame = fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]);
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("clears the armed passthrough on the next write so it cannot leak to a later redraw", async () => {
		const terminal = preserving();
		terminal.setViewportTopProvider(() => 5);
		terminal.passNextFullRedraw();
		// The toggle's own render turned out to be a differential frame; the
		// flag must not survive it.
		terminal.write(`${SYNC_START}\r\x1b[2Kupdated line${SYNC_END}`);
		await flushMicrotasks();
		terminal.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]));
		await flushMicrotasks();
		expect(chunks[1]).toBe(
			`${SYNC_START}\x1b[H\x1b[2Kl2\r\n\x1b[2Kl3\r\n\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\x1b[J${SYNC_END}`,
		);
		terminal.stop();
	});

	it("skips the scroll-in path on the frame that follows a height change", async () => {
		const terminal = preserving();
		terminal.setViewportTopProvider(() => 0);
		terminal.write("prime");
		await flushMicrotasks();
		terminal.rowCount = 3;
		// After a resize the renderer's viewport bookkeeping no longer matches
		// what the terminal did to the screen; the frame passes through with
		// the upstream wipe instead of trusting the provider.
		const frame = fullRedrawFrame(["l1", "l2", "l3", "l4", "l5"]);
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks[1]).toBe(frame);
		terminal.stop();
	});
});
