import { closeSync, openSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import {
	createOutputFilePath,
	createOutputFileStream,
	type OutputFileResult,
	type OutputFileStream,
} from "../../utils/output-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/** Managed executions persist from the first byte, without an unbounded stream write queue. */
	persistFromStart?: boolean;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** Set once the full output goes to a file. While output streams in, `saved` means the file is being written. */
	fullOutputFile?: OutputFileResult;
}

export interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly persistFromStart: boolean;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileFd: number | undefined;
	private tempFile: OutputFileStream | undefined;
	private tempFileFailure: { kind: "failed"; error: string } | undefined;
	private diskPersistingStopped = false;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.persistFromStart = options.persistFromStart === true;
		if (this.persistFromStart) {
			const path = createOutputFilePath(this.tempFilePrefix, ".log");
			this.tempFilePath = path;
			try {
				this.tempFileFd = openSync(path, "wx", 0o600);
			} catch (error) {
				// Report construction failure through the first snapshot so the managed execution owner
				// can fail the task before spawn. Nothing exists to remove when open fails.
				this.tempFileFailure = { kind: "failed", error: errorMessage(error) };
			}
		}
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.diskPersistingStopped) {
			return;
		}
		if (this.tempFileFd !== undefined) {
			this.writeSyncFile(data);
			return;
		}
		// A managed execution has one log from the first byte. If that log could not be opened or
		// already failed, do not replace it with a second file; the retained tail is the fallback.
		if (this.persistFromStart) {
			return;
		}
		if (this.tempFile || this.shouldUseTempFile()) {
			this.ensureTempFile()?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	/** Stop writing additional bytes to disk while continuing to track the rolling tail in memory. */
	stopPersisting(): void {
		this.diskPersistingStopped = true;
		this.closeSyncFile();
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (!this.diskPersistingStopped && this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean; maxBytes?: number } = {}): OutputSnapshot {
		const maxBytes = Math.min(this.maxBytes, options.maxBytes ?? this.maxBytes);
		const tailTruncation = truncateTail(this.getRetainedText(), {
			maxLines: this.maxLines,
			maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return { content: truncation.content, truncation, fullOutputFile: this.outputFileResult() };
	}

	getTotalBytes(): number {
		return this.totalRawBytes;
	}

	/** Flush and close the temp file. Never rejects: a failed file shows up as `failed` in later snapshots. */
	async closeTempFile(): Promise<void> {
		this.closeSyncFile();
		await this.tempFile?.close();
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker. When the temp file could not be saved, only
	 * the retained tail is left: up to its last `maxBytes` bytes, behind the same marker when output is
	 * missing.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		const fullOutputFile = this.outputFileResult();
		if (!fullOutputFile) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		if (fullOutputFile.kind === "failed") {
			return this.readRetainedOutput(maxBytes);
		}
		const file = await open(fullOutputFile.path, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	/**
	 * The retained tail, for display and as the fallback of `readFullOutput()`. Clipping drops the partial
	 * first line of the tail. When the tail is only the end of one over-long line (plus blank lines),
	 * nothing is left, so it keeps the end of that line instead.
	 */
	private getRetainedText(): string {
		const clippedText = this.getSnapshotText();
		return clippedText.trim().length === 0 ? this.tailText : clippedText;
	}

	/** The retained tail within `maxBytes`, marked as truncated only when output is missing. */
	private readRetainedOutput(maxBytes: number): FullOutput {
		let bytes = Buffer.from(this.getRetainedText(), "utf-8");
		if (bytes.length > maxBytes) {
			let start = bytes.length - maxBytes;
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
			bytes = bytes.subarray(start);
		}
		const tail = bytes.toString("utf-8");
		const omitted = this.totalDecodedBytes - bytes.length;
		if (omitted === 0) {
			return { content: tail, truncated: false };
		}
		return { content: `[... ${omitted} bytes omitted ...]\n\n${tail}`, truncated: true };
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private outputFileResult(): OutputFileResult | undefined {
		if (this.tempFile) {
			return this.tempFile.result;
		}
		if (!this.tempFilePath) {
			return undefined;
		}
		return this.tempFileFailure ?? { kind: "saved", path: this.tempFilePath };
	}

	private writeSyncFile(data: Buffer): void {
		const fd = this.tempFileFd;
		if (fd === undefined) {
			return;
		}
		try {
			let offset = 0;
			while (offset < data.length) {
				const written = writeSync(fd, data, offset, data.length - offset);
				if (written === 0) throw new Error("Output file write made no progress");
				offset += written;
			}
		} catch (error) {
			// The output owner turns this synchronous failure into a task failure. Still record it here so
			// snapshots and structured output explain the missing full output instead of naming a partial file.
			this.tempFileFd = undefined;
			try {
				closeSync(fd);
			} catch {
				// The write failure is the actionable error.
			}
			this.failSyncFile(error);
			throw error;
		}
	}

	private closeSyncFile(): void {
		const fd = this.tempFileFd;
		if (fd === undefined) {
			return;
		}
		this.tempFileFd = undefined;
		try {
			closeSync(fd);
		} catch (error) {
			this.failSyncFile(error);
		}
	}

	private failSyncFile(error: unknown): void {
		// Managed task logs are diagnostic artifacts: a partial one stays attached for the task's
		// retention-aware cleanup, unlike an unmanaged full-output temp file that upstream drops.
		this.tempFileFailure ??= { kind: "failed", error: errorMessage(error) };
	}

	private ensureTempFile(): OutputFileStream | undefined {
		if (this.tempFile) {
			return this.tempFile;
		}
		if (this.persistFromStart) {
			return undefined;
		}
		const tempFile = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFile = tempFile;
		for (const chunk of this.rawChunks) {
			tempFile.write(chunk);
		}
		this.rawChunks = [];
		return tempFile;
	}
}
