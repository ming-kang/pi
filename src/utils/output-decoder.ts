import { isUtf8 } from "node:buffer";
import { spawnSync } from "child_process";

/**
 * Windows OEM code pages mapped to WHATWG TextDecoder labels. Console
 * programs emit piped output in the OEM code page, so only code pages that
 * TextDecoder can represent are listed; others keep UTF-8 decoding.
 */
const OEM_CODE_PAGE_ENCODINGS: Record<string, string> = {
	"866": "ibm866",
	"874": "windows-874",
	"932": "shift_jis",
	"936": "gbk",
	"949": "euc-kr",
	"950": "big5",
	"1251": "windows-1251",
	"1252": "windows-1252",
};

let cachedConsoleFallbackEncoding: string | null | undefined;

/**
 * Resolve the fallback encoding for console output on this system.
 *
 * On Windows, cmd.exe builtins, Windows PowerShell, and classic console tools
 * such as ipconfig emit piped output in the legacy OEM code page (GBK on
 * Simplified Chinese systems, Shift_JIS on Japanese systems, and so on)
 * rather than UTF-8. Returns the TextDecoder label for that code page, or
 * null when output should stay UTF-8: non-Windows platforms, UTF-8 systems
 * (code page 65001), and code pages TextDecoder cannot represent.
 */
export function getConsoleFallbackEncoding(): string | null {
	if (cachedConsoleFallbackEncoding === undefined) {
		cachedConsoleFallbackEncoding = detectConsoleFallbackEncoding();
	}
	return cachedConsoleFallbackEncoding;
}

function detectConsoleFallbackEncoding(): string | null {
	if (process.platform !== "win32") {
		return null;
	}
	try {
		const result = spawnSync(
			"reg",
			["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"],
			{ encoding: "utf-8", timeout: 5000, windowsHide: true },
		);
		if (result.status !== 0 || !result.stdout) {
			return null;
		}
		const match = result.stdout.match(/OEMCP\s+REG_SZ\s+(\d+)/);
		const encoding = match ? OEM_CODE_PAGE_ENCODINGS[match[1]] : undefined;
		if (!encoding) {
			return null;
		}
		// Node builds with small-icu lack these decoders; verify availability.
		new TextDecoder(encoding);
		return encoding;
	} catch {
		return null;
	}
}

/**
 * Bound on the undecided (no line boundary yet) byte carry. A single line
 * longer than this is force-decoded so memory stays flat and streaming
 * latency stays bounded.
 */
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024;

const LF = 0x0a;
const CR = 0x0d;

/**
 * Characters that essentially never appear in legitimate console text:
 * C0 controls except tab, LF, CR, and ESC (ANSI sequences), plus DEL and the
 * replacement character. Their presence in a fallback-decoded line means the
 * bytes were binary, not OEM-encoded text.
 */
const NON_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F\uFFFD]/;

/** Byte-level version of NON_TEXT_RE, checked before any decode. */
function containsBinaryBytes(buf: Buffer): boolean {
	for (const b of buf) {
		if (b > 0x1f) {
			if (b === 0x7f) {
				return true;
			}
			continue;
		}
		if (b !== 0x09 && b !== LF && b !== CR && b !== 0x1b) {
			return true;
		}
	}
	return false;
}

/**
 * Number of trailing bytes that form the start of an incomplete but
 * well-formed UTF-8 sequence, or 0 when the buffer ends at a character
 * boundary (or in bytes no completion could repair).
 */
function utf8PartialTailLength(buf: Buffer): number {
	for (let i = 1; i <= 3 && i <= buf.length; i++) {
		const b = buf[buf.length - i];
		if ((b & 0xc0) === 0xc0) {
			const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
			return i < need ? i : 0;
		}
		if ((b & 0xc0) !== 0x80) {
			return 0;
		}
	}
	return 0;
}

/**
 * Streaming decoder that decodes UTF-8 output and falls back to the system
 * console encoding for the parts of the stream that are not UTF-8.
 *
 * The stream is segmented at line boundaries — LF and CR are single-byte
 * codes in every supported fallback encoding, so they are safe split points —
 * and each line is decided independently: valid UTF-8 stays UTF-8, invalid
 * lines are decoded with the fallback encoding. Mixed streams (a UTF-8 tool
 * followed by an OEM-code-page tool, or the reverse) therefore decode
 * correctly line by line; nothing already emitted is ever revised.
 *
 * Binary data is kept away from the fallback: a segment containing bytes
 * that console text never contains, or a fallback decode that produces such
 * characters, is decoded as UTF-8 (with replacement characters) so downstream
 * binary sanitization sees it unchanged.
 *
 * The ASCII prefix of an incomplete line is emitted immediately — ASCII is
 * identical in UTF-8 and in every fallback encoding — so plain-text output
 * still streams with no added latency. Only the non-ASCII part of an
 * unfinished line is held back, bounded by `maxPendingBytes`.
 */
export class OutputDecoder {
	private readonly utf8 = new TextDecoder();
	private readonly utf8Stream = new TextDecoder();
	private readonly fallback: TextDecoder | null;
	private readonly maxPendingBytes: number;
	private carry: Buffer | null = null;

	constructor(options: { fallbackEncoding?: string | null; maxPendingBytes?: number } = {}) {
		const label = options.fallbackEncoding === undefined ? getConsoleFallbackEncoding() : options.fallbackEncoding;
		let fallback: TextDecoder | null = null;
		if (label !== null) {
			try {
				fallback = new TextDecoder(label);
			} catch {
				fallback = null;
			}
		}
		this.fallback = fallback;
		this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
	}

	push(data: Buffer): string {
		if (!this.fallback) {
			return this.utf8Stream.decode(data, { stream: true });
		}

		let buf = this.carry ? Buffer.concat([this.carry, data]) : data;
		this.carry = null;
		let out = "";

		const boundary = Math.max(buf.lastIndexOf(LF), buf.lastIndexOf(CR));
		if (boundary >= 0) {
			out += this.decodeSegment(buf.subarray(0, boundary + 1));
			buf = buf.subarray(boundary + 1);
		}

		// Emit the encoding-neutral ASCII prefix of the unfinished line.
		let firstHigh = 0;
		while (firstHigh < buf.length && buf[firstHigh] < 0x80) {
			firstHigh++;
		}
		if (firstHigh > 0) {
			out += this.utf8.decode(buf.subarray(0, firstHigh));
			buf = buf.subarray(firstHigh);
		}

		if (buf.length > 0) {
			if (buf.length > this.maxPendingBytes) {
				out += this.forceDecide(buf);
			} else {
				this.carry = buf;
			}
		}
		return out;
	}

	flush(): string {
		if (!this.fallback) {
			return this.utf8Stream.decode();
		}
		const buf = this.carry;
		this.carry = null;
		return buf ? this.decodeSegment(buf) : "";
	}

	/** Decode a run of complete lines (or the final remainder at flush). */
	private decodeSegment(buf: Buffer): string {
		if (buf.length === 0) {
			return "";
		}
		if (isUtf8(buf) || containsBinaryBytes(buf)) {
			return this.utf8.decode(buf);
		}
		let out = "";
		let start = 0;
		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === LF || buf[i] === CR) {
				out += this.decodeLine(buf.subarray(start, i + 1));
				start = i + 1;
			}
		}
		if (start < buf.length) {
			out += this.decodeLine(buf.subarray(start));
		}
		return out;
	}

	private decodeLine(line: Buffer): string {
		if (isUtf8(line)) {
			return this.utf8.decode(line);
		}
		const text = (this.fallback as TextDecoder).decode(line);
		return NON_TEXT_RE.test(text) ? this.utf8.decode(line) : text;
	}

	/**
	 * A single line outgrew maxPendingBytes: decode what is decidable now.
	 * May keep a few trailing bytes in the carry when they look like the
	 * start of a character the next push will complete.
	 */
	private forceDecide(buf: Buffer): string {
		if (containsBinaryBytes(buf)) {
			return this.utf8.decode(buf);
		}

		const tail = utf8PartialTailLength(buf);
		const head = tail > 0 ? buf.subarray(0, buf.length - tail) : buf;
		if (isUtf8(head)) {
			this.carry = tail > 0 ? buf.subarray(buf.length - tail) : null;
			return this.utf8.decode(head);
		}

		// Not UTF-8: try the fallback, holding back the final byte when that
		// is what lets the decode end on a clean character boundary.
		for (const holdback of [0, 1]) {
			if (holdback >= buf.length || (holdback === 1 && buf[buf.length - 1] < 0x80)) {
				break;
			}
			const text = (this.fallback as TextDecoder).decode(buf.subarray(0, buf.length - holdback));
			if (!text.includes("�")) {
				if (NON_TEXT_RE.test(text)) {
					break;
				}
				this.carry = holdback === 1 ? buf.subarray(buf.length - 1) : null;
				return text;
			}
		}
		return this.utf8.decode(buf);
	}
}
