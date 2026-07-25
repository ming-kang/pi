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
		const { text, rewound } = decoder.push(chunk);
		if (rewound) transcript = "";
		transcript += text;
	}
	const final = decoder.flush();
	if (final.rewound) transcript = "";
	return transcript + final.text;
}

describe("OutputDecoder", () => {
	it("passes ASCII through without rewinding", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const result = decoder.push(Buffer.from("hello world\n"));
		expect(result).toEqual({ text: "hello world\n", rewound: false });
	});

	it("passes valid UTF-8 CJK through without rewinding", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const result = decoder.push(Buffer.from("中文测试\n", "utf-8"));
		expect(result.rewound).toBe(false);
		expect(result.text).toBe("中文测试\n");
	});

	it("reassembles UTF-8 characters split across chunks", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const bytes = Buffer.from("中文", "utf-8");
		const text = decodeAll(decoder, [bytes.subarray(0, 2), bytes.subarray(2)]);
		expect(text).toBe("中文");
	});

	it("rewinds to the fallback encoding for GBK output", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const result = decoder.push(GBK_ZHONGWEN);
		expect(result.rewound).toBe(true);
		expect(result.text).toBe("中文");
	});

	it("re-decodes the ASCII prefix seen before the switch", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const first = decoder.push(Buffer.from("Active code page: 936\n"));
		expect(first.rewound).toBe(false);
		const second = decoder.push(GBK_ERROR_LINE);
		expect(second.rewound).toBe(true);
		expect(second.text).toBe("Active code page: 936\n错误: 无效语法。");
	});

	it("decodes GBK characters split across chunks after the switch", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const text = decodeAll(decoder, [GBK_ZHONGWEN.subarray(0, 1), GBK_ZHONGWEN.subarray(1), GBK_ZHONGWEN]);
		expect(text).toBe("中文中文");
	});

	it("rewinds on flush when the stream ends with invalid UTF-8", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		expect(decoder.push(Buffer.concat([Buffer.from("done "), GBK_ZHONGWEN.subarray(0, 1)])).rewound).toBe(false);
		const final = decoder.flush();
		expect(final.rewound).toBe(true);
		expect(final.text).toBe("done ");
	});

	it("keeps UTF-8 when the source genuinely contains replacement characters", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk" });
		const result = decoder.push(Buffer.from("bad byte: �\n", "utf-8"));
		expect(result.rewound).toBe(false);
		expect(result.text).toBe("bad byte: �\n");
	});

	it("stays on UTF-8 when no fallback encoding is available", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: null });
		const result = decoder.push(GBK_ZHONGWEN);
		expect(result.rewound).toBe(false);
		expect(result.text).toContain("�");
	});

	it("locks to UTF-8 once the detection byte limit is exceeded", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "gbk", detectionLimitBytes: 8 });
		decoder.push(Buffer.from("0123456789"));
		const result = decoder.push(GBK_ZHONGWEN);
		expect(result.rewound).toBe(false);
		expect(result.text).toContain("�");
	});

	it("supports other CJK fallback encodings", () => {
		const decoder = new OutputDecoder({ fallbackEncoding: "shift_jis" });
		const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]); // 日本
		const result = decoder.push(sjis);
		expect(result.rewound).toBe(true);
		expect(result.text).toBe("日本");
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
	it("rebuilds the snapshot after a mid-stream encoding switch", () => {
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

describe.skipIf(process.platform !== "win32")("Windows console output end to end", () => {
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
});
