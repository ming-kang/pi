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

export interface DecodedChunk {
	/** Decoded text for this push, or the full re-decoded transcript when rewound. */
	text: string;
	/**
	 * True when the decoder switched to the fallback encoding. All previously
	 * returned text is invalid; `text` replaces the entire transcript.
	 */
	rewound: boolean;
}

const DEFAULT_DETECTION_LIMIT_BYTES = 256 * 1024;

/**
 * Streaming decoder that assumes UTF-8 and falls back to the system console
 * encoding when the stream turns out not to be UTF-8.
 *
 * Decoding starts as plain streaming UTF-8 — the fast path for virtually all
 * output. When a replacement character appears, the bytes seen so far are
 * checked with isUtf8: if they are genuinely invalid UTF-8, everything is
 * re-decoded with the fallback encoding and the result is reported with
 * `rewound: true` so the caller can rebuild its derived state. If the bytes
 * are valid UTF-8 (the source itself contained replacement characters),
 * detection stops and UTF-8 decoding continues.
 *
 * Raw bytes are retained only while detection is active and only up to
 * `detectionLimitBytes`; larger streams lock to UTF-8 and memory stays flat.
 */
export class OutputDecoder {
	private decoder = new TextDecoder();
	private readonly fallbackEncoding: string | null;
	private readonly detectionLimitBytes: number;
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private detecting: boolean;

	constructor(options: { fallbackEncoding?: string | null; detectionLimitBytes?: number } = {}) {
		this.fallbackEncoding =
			options.fallbackEncoding === undefined ? getConsoleFallbackEncoding() : options.fallbackEncoding;
		this.detectionLimitBytes = options.detectionLimitBytes ?? DEFAULT_DETECTION_LIMIT_BYTES;
		this.detecting = this.fallbackEncoding !== null;
	}

	push(data: Buffer): DecodedChunk {
		const text = this.decoder.decode(data, { stream: true });
		if (!this.detecting) {
			return { text, rewound: false };
		}
		this.pending.push(data);
		this.pendingBytes += data.length;
		if (text.includes("�")) {
			return this.tryRewind(text);
		}
		if (this.pendingBytes > this.detectionLimitBytes) {
			this.stopDetecting();
		}
		return { text, rewound: false };
	}

	flush(): DecodedChunk {
		const text = this.decoder.decode();
		if (this.detecting && text.includes("�")) {
			return this.tryRewind(text);
		}
		this.stopDetecting();
		return { text, rewound: false };
	}

	private tryRewind(utf8Text: string): DecodedChunk {
		const raw = Buffer.concat(this.pending);
		if (isUtf8(raw)) {
			// The replacement characters exist in the source bytes themselves;
			// the stream is valid UTF-8, so stop watching and keep it.
			this.stopDetecting();
			return { text: utf8Text, rewound: false };
		}
		try {
			this.decoder = new TextDecoder(this.fallbackEncoding as string);
		} catch {
			this.stopDetecting();
			return { text: utf8Text, rewound: false };
		}
		const text = this.decoder.decode(raw, { stream: true });
		this.stopDetecting();
		return { text, rewound: true };
	}

	private stopDetecting(): void {
		this.detecting = false;
		this.pending = [];
		this.pendingBytes = 0;
	}
}
