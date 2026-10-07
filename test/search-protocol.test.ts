import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	connectFrameDecode,
	connectFrameEncode,
	decodeVarint,
	extractStrings,
	ProtobufEncoder,
} from "../src/extensions/search/protocol.ts";

describe("ProtobufEncoder", () => {
	it("encodes varint, string, and bytes fields", () => {
		expect([...new ProtobufEncoder().writeVarint(1, 300).toBuffer()]).toEqual([0x08, 0xac, 0x02]);
		expect([...new ProtobufEncoder().writeString(3, "hi").toBuffer()]).toEqual([0x1a, 0x02, 0x68, 0x69]);
		expect([...new ProtobufEncoder().writeBytes(30, Buffer.from([0x00, 0x01])).toBuffer()]).toEqual([
			0xf2, 0x01, 0x02, 0x00, 0x01,
		]);
	});

	it("nests a message as a length-delimited field", () => {
		const sub = new ProtobufEncoder().writeString(1, "hi");
		const msg = new ProtobufEncoder().writeVarint(1, 300).writeMessage(6, sub).toBuffer();
		expect([...msg]).toEqual([0x08, 0xac, 0x02, 0x32, 0x04, 0x0a, 0x02, 0x68, 0x69]);
	});
});

describe("decodeVarint", () => {
	it("round-trips every width the encoder can produce", () => {
		for (const value of [0, 1, 127, 128, 300, 16384, 1 << 20, (1 << 28) - 1]) {
			const buf = new ProtobufEncoder().writeVarint(1, value).toBuffer();
			const [decoded, offset] = decodeVarint(buf, 1);
			expect(decoded, `value ${value}`).toBe(value);
			expect(offset, `offset ${value}`).toBe(buf.length);
		}
	});
});

describe("connect frames", () => {
	it("round-trips an uncompressed frame and its length header", () => {
		const msg = new ProtobufEncoder().writeString(3, "fast-context").toBuffer();
		const frame = connectFrameEncode(msg, false);
		expect(frame[0]).toBe(0);
		expect(frame.readUInt32BE(1)).toBe(msg.length);
		expect(connectFrameDecode(frame)).toEqual([msg]);
	});

	it("round-trips a gzip frame", () => {
		const msg = new ProtobufEncoder().writeString(3, "fast-context").toBuffer();
		const frame = connectFrameEncode(msg, true);
		expect(frame[0]).toBe(1);
		expect(connectFrameDecode(frame)).toEqual([msg]);
	});
});

describe("extractStrings", () => {
	it("keeps long strings and skips short ones", () => {
		const msg = new ProtobufEncoder().writeString(3, "fast-context").writeString(4, "tiny").toBuffer();
		expect(extractStrings(msg)).toContain("fast-context");
		expect(extractStrings(msg)).not.toContain("tiny");
	});

	it("walks past varint, fixed64, and fixed32 fields to reach a string", () => {
		const prefix = Buffer.from([
			0x08,
			0x96,
			0x01, // field 1, varint 150
			0x11,
			1,
			2,
			3,
			4,
			5,
			6,
			7,
			8, // field 2, fixed64
			0x1d,
			9,
			10,
			11,
			12, // field 3, fixed32
		]);
		const msg = Buffer.concat([prefix, new ProtobufEncoder().writeString(4, "fast-context").toBuffer()]);
		expect(extractStrings(msg)).toEqual(["fast-context"]);
	});

	it("stops cleanly when a length-delimited field is truncated", () => {
		expect(extractStrings(Buffer.from([0x22, 0x20, 0x61]))).toEqual([]);
	});
});

describe("upstream parity", () => {
	it("matches the upstream encoder when FC_UPSTREAM points at it", async () => {
		const upstream = process.env.FC_UPSTREAM;
		if (!upstream || !existsSync(upstream)) return;
		const up = await import(pathToFileURL(upstream).href);
		const build = (Enc: typeof ProtobufEncoder) => {
			const sub = new Enc().writeString(1, "hello-world");
			return new Enc()
				.writeVarint(2, 300)
				.writeString(3, "fast-context")
				.writeBytes(30, Buffer.from([0x00, 0x01]))
				.writeMessage(6, sub)
				.toBuffer();
		};
		const mine = build(ProtobufEncoder);
		expect(mine).toEqual(build(up.ProtobufEncoder));
		expect(extractStrings(mine)).toEqual(up.extractStrings(mine));
		expect(connectFrameDecode(connectFrameEncode(mine))).toEqual(up.connectFrameDecode(up.connectFrameEncode(mine)));
	});
});
