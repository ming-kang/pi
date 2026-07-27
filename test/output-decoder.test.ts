import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { getConsoleFallbackEncoding, OutputDecoder } from "../src/utils/output-decoder.ts";

/** "中文" encoded as GBK — invalid as UTF-8. */
const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
/** "错误: 无效语法。" as emitted by cmd.exe on a Simplified Chinese system. */
const GBK_ERROR_LINE = Buffer.concat([
	Buffer.from([0xb4, 0xed, 0xce, 0xf3]), // 错误
	Buffer.from(": ", "ascii"),
	Buffer.from([0xce, 0xde, 0xd0, 0xa7, 0xd3, 0xef, 0xb7, 0xa8]), // 无效语法
	Buffer.from([0xa1, 0xa3]), // 。
]);

function decodeAll(decoder: OutputDecoder, chunks: Buffer[]): string {
	let transcript = "";
	for (const chunk of chunks) {
		transcript += decoder.push(chunk);
	}
	return transcript + decoder.flush();
}

describe("OutputDecoder", () => {
	it("passes complete ASCII lines through immediately", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.push(Buffer.from("hello world\n"))).toBe("hello world\n");
	});

	it("passes complete UTF-8 CJK lines through immediately", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.push(Buffer.from("中文测试\n", "utf-8"))).toBe("中文测试\n");
	});

	it("streams the ASCII prefix of an unfinished line immediately", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.push(Buffer.from("Downloading... "))).toBe("Downloading... ");
		expect(decoder.push(Buffer.from("done\n"))).toBe("done\n");
	});

	it("reassembles UTF-8 characters split across chunks", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const bytes = Buffer.from("中文", "utf-8");
		expect(decodeAll(decoder, [bytes.subarray(0, 2), bytes.subarray(2)])).toBe("中文");
	});

	it("decodes GBK output with the fallback encoding", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decodeAll(decoder, [GBK_ZHONGWEN])).toBe("中文");
	});

	it("keeps the ASCII prefix intact ahead of a GBK line", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const text = decodeAll(decoder, [Buffer.from("Active code page: 936\n"), GBK_ERROR_LINE]);
		expect(text).toBe("Active code page: 936\n错误: 无效语法。");
	});

	it("decodes GBK characters split across chunks", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const text = decodeAll(decoder, [GBK_ZHONGWEN.subarray(0, 1), GBK_ZHONGWEN.subarray(1), GBK_ZHONGWEN]);
		expect(text).toBe("中文中文");
	});

	it("decodes a UTF-8 → GBK → UTF-8 mixed stream correctly", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const text = decodeAll(decoder, [
			Buffer.from("提交完成：修复编码\n", "utf-8"),
			Buffer.concat([GBK_ERROR_LINE, Buffer.from("\n")]),
			Buffer.from("再见\n", "utf-8"),
		]);
		expect(text).toBe("提交完成：修复编码\n错误: 无效语法。\n再见\n");
	});

	it("decodes a GBK → UTF-8 mixed stream correctly", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const text = decodeAll(decoder, [
			Buffer.concat([GBK_ERROR_LINE, Buffer.from("\n")]),
			Buffer.from("接下来是 UTF-8 中文\n", "utf-8"),
		]);
		expect(text).toBe("错误: 无效语法。\n接下来是 UTF-8 中文\n");
	});

	it("decodes mixed encodings arriving in a single chunk", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const chunk = Buffer.concat([
			Buffer.from("第一行是 UTF-8\n", "utf-8"),
			GBK_ERROR_LINE,
			Buffer.from("\n"),
			Buffer.from("第三行是 UTF-8\n", "utf-8"),
		]);
		expect(decodeAll(decoder, [chunk])).toBe("第一行是 UTF-8\n错误: 无效语法。\n第三行是 UTF-8\n");
	});

	it("renders a trailing incomplete sequence as a replacement character instead of dropping it", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.push(Buffer.concat([Buffer.from("done "), GBK_ZHONGWEN.subarray(0, 1)]))).toBe("done ");
		expect(decoder.flush()).toBe("�");
	});

	it("keeps UTF-8 when the source genuinely contains replacement characters", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.push(Buffer.from("bad byte: �\n", "utf-8"))).toBe("bad byte: �\n");
	});

	it("stays on UTF-8 when no fallback encoding is available", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: null });
		expect(decoder.push(GBK_ZHONGWEN)).toContain("�");
	});

	it("does not turn binary data into fallback-decoded CJK text", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		// PNG signature followed by the start of an IHDR chunk.
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48]);
		const text = decodeAll(decoder, [png]);
		expect(text).toContain("�");
		expect(text).not.toMatch(/[一-鿿]/);
	});

	it("rejects a fallback decode that produces control characters", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const line = Buffer.concat([GBK_ZHONGWEN, Buffer.from([0x01]), Buffer.from("\n")]);
		expect(decodeAll(decoder, [line])).not.toMatch(/[一-鿿]/);
	});

	it("accepts fallback text that carries ANSI escape sequences", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const line = Buffer.concat([Buffer.from("\x1b[31m"), GBK_ZHONGWEN, Buffer.from("\x1b[0m\n")]);
		expect(decodeAll(decoder, [line])).toContain("中文");
	});

	it("force-decodes a line that outgrows maxPendingBytes without waiting for a newline", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk", maxPendingBytes: 8 });
		const long = Buffer.concat([GBK_ZHONGWEN, GBK_ZHONGWEN, GBK_ZHONGWEN]);
		expect(decoder.push(long)).toBe("中文中文中文");
	});

	it("keeps fallback character alignment across a forced decode boundary", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk", maxPendingBytes: 8 });
		const long = Buffer.concat([GBK_ZHONGWEN, GBK_ZHONGWEN, GBK_ZHONGWEN, Buffer.from("\n")]);
		const text = decodeAll(decoder, [long.subarray(0, 11), long.subarray(11)]);
		expect(text).toBe("中文中文中文\n");
	});

	it("supports other CJK fallback encodings", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "shift_jis" });
		const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]); // 日本
		expect(decodeAll(decoder, [sjis])).toBe("日本");
	});
});

describe("getConsoleFallbackEncoding", () => {
	it("returns null on POSIX platforms and a known label or null on Windows", () => {
		const encoding = getConsoleFallbackEncoding();
		if (process.platform !== "win32") {
			expect(encoding).toBeNull();
		} else if (encoding !== null) {
			expect(() => new TextDecoder(encoding)).not.toThrow();
		}
	});
});

describe("OutputAccumulator encoding fallback", () => {
	it("decodes a GBK line arriving between UTF-8 lines", () => {
		const accumulator = new OutputAccumulator({ fallbackEncoding: "gbk" });
		accumulator.append(Buffer.from("line one\n"));
		accumulator.append(GBK_ERROR_LINE);
		accumulator.append(Buffer.from("\nline three\n"));
		accumulator.finish();

		const snapshot = accumulator.snapshot();
		expect(snapshot.content).toBe("line one\n错误: 无效语法。\nline three\n");
		expect(snapshot.truncation.totalLines).toBe(3);
		expect(snapshot.content).not.toContain("�");
	});

	it("keeps plain UTF-8 accumulation unchanged", () => {
		const accumulator = new OutputAccumulator({ fallbackEncoding: "gbk" });
		accumulator.append(Buffer.from("中文测试\n", "utf-8"));
		accumulator.finish();
		expect(accumulator.snapshot().content).toBe("中文测试\n");
	});
});

describe.skipIf(process.platform !== "win32" || getConsoleFallbackEncoding() === null)(
	"Windows console output end to end",
	() => {
		it("decodes cmd.exe OEM output without replacement characters", async () => {
			const ops = createLocalBashOperations();
			const result = await executeBashWithOperations("cmd //c chcp", process.cwd(), ops);
			expect(result.exitCode).toBe(0);
			expect(result.output).not.toContain("�");
			expect(result.output).toMatch(/\d{3,5}/);
		}, 30000);

		it("round-trips CJK text through a cmd.exe echo", async () => {
			const ops = createLocalBashOperations();
			const result = await executeBashWithOperations('cmd //c "echo 中文乱码测试"', process.cwd(), ops);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("中文乱码测试");
			expect(result.output).not.toContain("�");
		}, 30000);
	},
);
