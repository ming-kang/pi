import { ProcessTerminal } from "@earendil-works/pi-tui";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
/** Clear screen, home, clear scrollback — pi-tui's fullRender(clear) preamble. */
const CLEAR_WITH_SCROLLBACK = "\x1b[2J\x1b[H\x1b[3J";
/** Kitty graphics APC prefix; frames touching images interleave cursor moves. */
const KITTY_APC_PREFIX = "\x1b_G";

/**
 * ProcessTerminal that (1) coalesces every write issued within one synchronous
 * task into a single stdout write and (2) keeps content-driven full redraws
 * from destroying the terminal's scrollback.
 *
 * Coalescing: pi-tui emits each render pass as several separate stdout
 * writes: the frame wrapped in synchronized output (CSI ?2026h/l), then a
 * relative cursor move that parks the hardware cursor at the focused
 * component's caret for IME composition, then a cursor visibility toggle.
 * Terminals that anchor the IME candidate window to the hardware cursor
 * (Windows Terminal and other ConPTY hosts, WezTerm) can process the frame
 * write before the reposition write arrives, briefly leaving the cursor at
 * the end of the last repainted line. With an IME active this makes the
 * candidate window jump between the caret and the right edge of the input
 * line on every keystroke. Merging the writes makes each frame atomic, so the
 * only cursor position a terminal can observe is the final one.
 *
 * Scrollback preservation: pi-tui's fullRender(clear) opens with
 * `2J H 3J`, wiping the terminal's scrollback, and then replays the entire
 * transcript. Content-driven triggers (a line changing above the viewport
 * during streaming markdown reflow, large content shrinks) fire this
 * routinely, which erases pre-session shell history and — in terminals that
 * clamp the scroll offset when scrollback vanishes, notably Windows
 * Terminal — yanks a scrolled-up viewport to the top of the buffer
 * (upstream #6502, #5576, #6050; rejected upstream fix #4204). Frames
 * matching that shape are rewritten to overwrite the visible screen in place
 * (home, erase-and-rewrite each row, erase below) with only the bottom
 * viewport-height rows, which leaves scrollback (and the reader's scroll
 * position) untouched while producing a byte-identical final screen state.
 * ED 2 is avoided entirely because conhost/Windows Terminal implement it by
 * scrolling the screen contents into scrollback rather than erasing in
 * place. Width-change redraws keep the upstream wipe because
 * re-wrapped content genuinely invalidates old scrollback, and frames
 * containing kitty graphics pass through untouched. A frame that does not
 * match the expected shape is passed through unchanged, so if upstream
 * reshapes its render output the wrapper degrades back to stock behavior.
 */
export class CoalescingTerminal extends ProcessTerminal {
	private pending = "";
	private flushQueued = false;
	private lastWriteColumns: number | undefined;
	private flushOnExit = () => this.flush();

	constructor() {
		super();
		// A synchronous process.exit() before the queued microtask runs would
		// otherwise drop the final frame.
		process.on("exit", this.flushOnExit);
	}

	override write(data: string): void {
		if (data.length === 0) return;
		this.pending += this.preserveScrollback(data);
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

	/**
	 * Rewrite a full-redraw frame (`?2026h 2J H 3J <lines> ?2026l`) so it
	 * repaints the screen without wiping scrollback. Anything that does not
	 * match this exact shape — including width-change redraws and frames
	 * touching kitty images — passes through unchanged.
	 */
	private preserveScrollback(data: string): string {
		const columns = this.columns;
		const widthChanged = this.lastWriteColumns !== undefined && this.lastWriteColumns !== columns;
		this.lastWriteColumns = columns;

		const prefix = SYNC_START + CLEAR_WITH_SCROLLBACK;
		if (!data.startsWith(prefix) || !data.endsWith(SYNC_END)) {
			return data;
		}
		// Re-wrapped content invalidates what scrollback holds; keep the wipe.
		if (widthChanged) {
			return data;
		}
		if (data.includes(KITTY_APC_PREFIX)) {
			return data;
		}
		const body = data.slice(prefix.length, data.length - SYNC_END.length);
		// A second clear inside one write means the frame shape changed
		// upstream; bail out rather than guess.
		if (body.includes(CLEAR_WITH_SCROLLBACK)) {
			return data;
		}
		// Repaint only the bottom viewport-height rows, overwriting the screen
		// in place: home, erase-and-rewrite each row, erase whatever remains
		// below. Writing the full transcript after a screen clear would push a
		// duplicate copy of everything above the viewport into scrollback; the
		// truncated overwrite produces the exact same final screen and cursor
		// position as the full replay (rows beyond the screen would have
		// scrolled out anyway). ED 2 (`2J`) is deliberately avoided even for
		// the visible screen: conhost/Windows Terminal implement it by
		// scrolling the current screen into scrollback (cls compatibility), so
		// without the `3J` wipe each redraw would stack another screenful of
		// duplicates into history.
		const lines = body.split("\r\n");
		const rows = this.rows;
		const kept = lines.length > rows ? lines.slice(lines.length - rows) : lines;
		const repaint = kept.map((line) => `\x1b[2K${line}`).join("\r\n");
		return `${SYNC_START}\x1b[H${repaint}\x1b[J${SYNC_END}`;
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
