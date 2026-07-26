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
