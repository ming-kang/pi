import { ProcessTerminal } from "@earendil-works/pi-tui";

/**
 * ProcessTerminal that coalesces every write issued within one synchronous
 * task into a single stdout write.
 *
 * pi-tui emits each render pass as several separate stdout writes: the frame
 * wrapped in synchronized output (CSI ?2026h/l), then a relative cursor move
 * that parks the hardware cursor at the focused component's caret for IME
 * composition, then a cursor visibility toggle. Terminals that anchor the IME
 * candidate window to the hardware cursor (Windows Terminal and other ConPTY
 * hosts, WezTerm) can process the frame write before the reposition write
 * arrives, briefly leaving the cursor at the end of the last repainted line.
 * With an IME active this makes the candidate window jump between the caret
 * and the right edge of the input line on every keystroke. Merging the writes
 * makes each frame atomic, so the only cursor position a terminal can observe
 * is the final one.
 */
export class CoalescingTerminal extends ProcessTerminal {
	private pending = "";
	private flushQueued = false;
	private flushOnExit = () => this.flush();

	constructor() {
		super();
		// A synchronous process.exit() before the queued microtask runs would
		// otherwise drop the final frame.
		process.on("exit", this.flushOnExit);
	}

	override write(data: string): void {
		if (data.length === 0) return;
		this.pending += data;
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => this.flush());
	}

	// Route every escape-sequence helper through the coalescing buffer so a
	// caller mixing helpers with write() keeps its output ordered.
	override moveBy(lines: number): void {
		if (lines > 0) {
			this.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			this.write(`\x1b[${-lines}A`);
		}
	}

	override hideCursor(): void {
		this.write("\x1b[?25l");
	}

	override showCursor(): void {
		this.write("\x1b[?25h");
	}

	override clearLine(): void {
		this.write("\x1b[K");
	}

	override clearFromCursor(): void {
		this.write("\x1b[J");
	}

	override clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	override stop(): void {
		// ProcessTerminal.stop() writes its teardown sequences directly to
		// stdout, so pending frame data must go out first.
		this.flush();
		process.removeListener("exit", this.flushOnExit);
		super.stop();
	}

	private flush(): void {
		this.flushQueued = false;
		if (this.pending.length === 0) {
			return;
		}
		const data = this.pending;
		this.pending = "";
		super.write(data);
	}
}
