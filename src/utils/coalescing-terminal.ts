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
 * transcript. During streaming, content-driven triggers (a line changing
 * above the viewport during markdown reflow) fire this routinely, which — in
 * terminals that clamp the scroll offset when scrollback vanishes, notably
 * Windows Terminal — yanks a scrolled-up reader to the top of the buffer on
 * every reflow (upstream #6502, #5576, #6050; rejected upstream fix #4204).
 *
 * Preservation is therefore windowed, not permanent: the host enables it via
 * setScrollbackPreservation while an agent run is mutating the transcript
 * (and keeps it on until the user's next input after the run settles, since
 * they may still be scrolled up reading), and leaves it off otherwise. An
 * idle-session full redraw — Ctrl+O toggles, mode switches — passes through
 * with upstream's wipe-and-replay, whose result is byte-perfect: scrollback
 * becomes the clean new transcript. Mid-run user toggles can arm
 * passNextFullRedraw for the same clean replay on their own frame.
 *
 * While preservation is active, a matching frame is rewritten to repaint
 * without the wipe. With setViewportTopProvider wired, the rewrite knows
 * which transcript line the visible screen starts at, so a frame that grew
 * the transcript repaints the on-screen rows with the new content at those
 * same positions and then scrolls the extra lines in at the bottom row.
 * Each bottom-row newline pushes the top row — already repainted with the
 * correct new content — into scrollback, exactly like ordinary streaming
 * output, so scrollback ends up byte-equivalent to the upstream full replay
 * without ever clearing it. Without the provider, or when the transcript
 * shrank (lines cannot be pulled back out of scrollback), the rewrite falls
 * back to overwriting the visible screen in place with the bottom
 * viewport-height rows, at the cost of a stale seam above the screen. ED 2
 * is avoided entirely in rewritten frames because conhost/Windows Terminal
 * implement it by scrolling the screen contents into scrollback rather than
 * erasing in place.
 *
 * Width- and height-change redraws keep the upstream wipe because re-wrapped
 * content genuinely invalidates old scrollback, and frames containing kitty
 * graphics pass through untouched. A frame that does not match the expected
 * shape is passed through unchanged, so if upstream reshapes its render
 * output the wrapper degrades back to stock behavior.
 */
export class CoalescingTerminal extends ProcessTerminal {
	private pending = "";
	private flushQueued = false;
	private lastWriteColumns: number | undefined;
	private lastWriteRows: number | undefined;
	private viewportTopProvider: (() => number | undefined) | undefined;
	private preserve = false;
	private passArmed = false;
	private flushOnExit = () => this.flush();

	/**
	 * Enable or disable the scrollback-preserving rewrite. Preservation is
	 * only worth its imperfections (stale renderings above the screen, seams
	 * on shrink) while the transcript is mutating on its own and the reader
	 * may be scrolled up — i.e. during an agent run and until the user's next
	 * input after it settles. Outside that window every full redraw passes
	 * through with upstream's wipe-and-replay, whose result is byte-perfect:
	 * scrollback becomes the clean new transcript. Default: disabled.
	 */
	setScrollbackPreservation(enabled: boolean): void {
		this.preserve = enabled;
	}

	/**
	 * Arm a one-shot exemption for an explicit user action (Ctrl+O tool
	 * expansion, thinking visibility) so its own full redraw keeps the
	 * upstream wipe-and-replay even while preservation is active mid-run.
	 * The user just pressed a key, so they are interacting at the bottom;
	 * a clean replay beats preservation's stale-seam trade-offs there. The
	 * flag is cleared by the next write so it cannot leak onto a later
	 * streaming redraw.
	 */
	passNextFullRedraw(): void {
		this.passArmed = true;
	}

	/**
	 * Wire the renderer's notion of which transcript line the visible screen
	 * currently starts at (pi-tui's `previousViewportTop`). Full-redraw frames
	 * that grew the transcript then scroll the new above-screen lines into
	 * scrollback instead of dropping them. The provider is read while the
	 * frame is being written, i.e. before the renderer updates its own
	 * bookkeeping for that frame; returning undefined falls back to the
	 * bottom-anchored in-place repaint.
	 */
	setViewportTopProvider(provider: () => number | undefined): void {
		this.viewportTopProvider = provider;
	}

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
		const rows = this.rows;
		const widthChanged = this.lastWriteColumns !== undefined && this.lastWriteColumns !== columns;
		const heightChanged = this.lastWriteRows !== undefined && this.lastWriteRows !== rows;
		this.lastWriteColumns = columns;
		this.lastWriteRows = rows;
		// One-shot: the very next write is the armed toggle's own frame (or a
		// differential frame when the toggle stayed inside the viewport, in
		// which case no exemption is needed and the flag must not linger).
		const passAllowed = this.passArmed;
		this.passArmed = false;

		const prefix = SYNC_START + CLEAR_WITH_SCROLLBACK;
		if (!data.startsWith(prefix) || !data.endsWith(SYNC_END)) {
			return data;
		}
		// Outside the preservation window (idle sessions, pre-session UI) and
		// for armed user toggles, upstream's wipe-and-replay is byte-perfect;
		// let it through.
		if (!this.preserve || passAllowed) {
			return data;
		}
		// Re-wrapped/re-flowed content invalidates what scrollback holds and
		// where the screen sits in it; keep the wipe.
		if (widthChanged || heightChanged) {
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
		// ED 2 (`2J`) is deliberately avoided in both rewrites below: conhost/
		// Windows Terminal implement it by scrolling the current screen into
		// scrollback (cls compatibility), so without the `3J` wipe each redraw
		// would stack another screenful of duplicates into history.
		const lines = body.split("\r\n");
		const newViewportTop = Math.max(0, lines.length - rows);
		const viewportTop = this.readViewportTop();
		if (viewportTop !== undefined && viewportTop <= newViewportTop) {
			// The transcript grew (or held steady): repaint the rows currently
			// on screen with the new content at those same transcript
			// positions, then scroll the remaining lines in at the bottom row.
			// Each bottom-row newline pushes the already-repainted top row into
			// scrollback, so scrollback receives exactly the new lines the
			// upstream replay would have put there — no wipe, no loss.
			const onScreen = lines.slice(viewportTop, viewportTop + rows);
			const scrolled = lines.slice(viewportTop + rows);
			let repaint = onScreen.map((line) => `\x1b[2K${line}`).join("\r\n");
			for (const line of scrolled) {
				repaint += `\r\n\x1b[2K${line}`;
			}
			return `${SYNC_START}\x1b[H${repaint}\x1b[J${SYNC_END}`;
		}
		// Fallback (no provider, or the transcript shrank — lines cannot be
		// pulled back out of scrollback): repaint only the bottom
		// viewport-height rows, overwriting the screen in place: home,
		// erase-and-rewrite each row, erase whatever remains below. Writing the
		// full transcript after a screen clear would push a duplicate copy of
		// everything above the viewport into scrollback; the truncated
		// overwrite produces the exact same final screen and cursor position as
		// the full replay (rows beyond the screen would have scrolled out
		// anyway).
		const kept = lines.length > rows ? lines.slice(lines.length - rows) : lines;
		const repaint = kept.map((line) => `\x1b[2K${line}`).join("\r\n");
		return `${SYNC_START}\x1b[H${repaint}\x1b[J${SYNC_END}`;
	}

	// The provider reaches into the renderer's bookkeeping; treat anything
	// unexpected as "unknown" and fall back rather than corrupt the screen.
	private readViewportTop(): number | undefined {
		if (!this.viewportTopProvider) return undefined;
		try {
			const value = this.viewportTopProvider();
			return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
		} catch {
			return undefined;
		}
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
