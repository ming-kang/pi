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
		const terminal = new SizedTerminal();
		const lines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
		terminal.write(fullRedrawFrame(lines));
		await flushMicrotasks();
		expect(chunks).toEqual([
			`${SYNC_START}\x1b[H\x1b[2Kl4\r\n\x1b[2Kl5\r\n\x1b[2Kl6\r\n\x1b[2Kl7\r\n\x1b[2Kl8\x1b[J${SYNC_END}`,
		]);
		terminal.stop();
	});

	it("keeps every line and erases below when the frame is shorter than the viewport", async () => {
		const terminal = new SizedTerminal();
		terminal.write(fullRedrawFrame(["a", "b", "c"]));
		await flushMicrotasks();
		expect(chunks).toEqual([`${SYNC_START}\x1b[H\x1b[2Ka\r\n\x1b[2Kb\r\n\x1b[2Kc\x1b[J${SYNC_END}`]);
		terminal.stop();
	});

	it("never emits ED 2 in rewritten frames (conhost scrolls it into scrollback)", async () => {
		const terminal = new SizedTerminal();
		terminal.write(fullRedrawFrame(["l1", "l2", "l3", "l4", "l5", "l6"]));
		await flushMicrotasks();
		expect(chunks.join("")).not.toContain("\x1b[2J");
		expect(chunks.join("")).not.toContain("\x1b[3J");
		terminal.stop();
	});

	it("keeps the upstream wipe when the terminal width changed", async () => {
		const terminal = new SizedTerminal();
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
		const terminal = new SizedTerminal();
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
		const terminal = new SizedTerminal();
		const frame = `${SYNC_START}\x1b_Ga=d,i=3\x1b\\${CLEAR_WITH_SCROLLBACK}l1\r\nl2${SYNC_END}`;
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("leaves differential render frames untouched", async () => {
		const terminal = new SizedTerminal();
		const frame = `${SYNC_START}\r\x1b[2Kupdated line${SYNC_END}`;
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("bails out when the frame contains a second clear sequence", async () => {
		const terminal = new SizedTerminal();
		const frame = `${SYNC_START}${CLEAR_WITH_SCROLLBACK}l1\r\n${CLEAR_WITH_SCROLLBACK}l2${SYNC_END}`;
		terminal.write(frame);
		await flushMicrotasks();
		expect(chunks).toEqual([frame]);
		terminal.stop();
	});

	it("still coalesces the rewritten frame with trailing cursor writes", async () => {
		const terminal = new SizedTerminal();
		terminal.write(fullRedrawFrame(["a", "b"]));
		terminal.write("\x1b[3G");
		terminal.hideCursor();
		await flushMicrotasks();
		expect(chunks).toEqual([`${SYNC_START}\x1b[H\x1b[2Ka\r\n\x1b[2Kb\x1b[J${SYNC_END}\x1b[3G\x1b[?25l`]);
		terminal.stop();
	});
});
