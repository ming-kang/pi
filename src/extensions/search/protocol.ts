import { gunzipSync, gzipSync } from "node:zlib";

export class ProtobufEncoder {
	_chunks: Buffer[] = [];

	_varint(value: number): Buffer {
		const bytes: number[] = [];
		while (value > 0x7f) {
			bytes.push((value & 0x7f) | 0x80);
			value >>>= 7;
		}
		bytes.push(value & 0x7f);
		return Buffer.from(bytes);
	}

	_tag(field: number, wire: number): Buffer {
		return this._varint((field << 3) | wire);
	}

	writeVarint(field: number, value: number): this {
		this._chunks.push(this._tag(field, 0), this._varint(value));
		return this;
	}

	writeString(field: number, value: string): this {
		const data = Buffer.from(value, "utf-8");
		this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
		return this;
	}

	writeBytes(field: number, value: Buffer | Uint8Array): this {
		const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
		this._chunks.push(this._tag(field, 2), this._varint(buf.length), buf);
		return this;
	}

	writeMessage(field: number, sub: ProtobufEncoder): this {
		const data = sub.toBuffer();
		this._chunks.push(this._tag(field, 2), this._varint(data.length), data);
		return this;
	}

	toBuffer(): Buffer {
		return Buffer.concat(this._chunks);
	}
}

export function decodeVarint(buf: Buffer, offset: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (offset < buf.length) {
		const b = buf[offset++]!;
		value |= (b & 0x7f) << shift;
		shift += 7;
		if (!(b & 0x80)) break;
	}
	return [value, offset];
}

export function extractStrings(data: Buffer): string[] {
	const strings: string[] = [];
	let i = 0;
	while (i < data.length) {
		let tag = 0;
		let shift = 0;
		while (i < data.length) {
			const b = data[i++]!;
			tag |= (b & 0x7f) << shift;
			shift += 7;
			if (!(b & 0x80)) break;
		}
		const wire = tag & 0x7;
		if (wire === 0) {
			while (i < data.length) {
				const b = data[i++]!;
				if (!(b & 0x80)) break;
			}
		} else if (wire === 1) {
			i += 8; // 64-bit fixed
		} else if (wire === 2) {
			let length = 0;
			shift = 0;
			while (i < data.length) {
				const b = data[i++]!;
				length |= (b & 0x7f) << shift;
				shift += 7;
				if (!(b & 0x80)) break;
			}
			if (i + length <= data.length) {
				const raw = data.subarray(i, i + length);
				try {
					const text = raw.toString("utf-8");
					if (text.length > 5) strings.push(text);
				} catch {}
			}
			i += length;
		} else if (wire === 5) {
			i += 4; // 32-bit fixed
		} else {
			break; // unknown wire type — stop
		}
	}
	return strings;
}

export function connectFrameEncode(protoBytes: Buffer, compress = true): Buffer {
	let payload: Buffer;
	let flags: number;
	if (compress) {
		payload = gzipSync(protoBytes);
		flags = 1; // gzip compressed
	} else {
		payload = protoBytes;
		flags = 0;
	}
	const header = Buffer.alloc(5);
	header[0] = flags;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

export function connectFrameDecode(data: Buffer): Buffer[] {
	const frames: Buffer[] = [];
	let i = 0;
	while (i + 5 <= data.length) {
		const flags = data[i]!;
		const length = data.readUInt32BE(i + 1);
		i += 5;
		let payload = data.subarray(i, i + length);
		i += length;
		if (flags === 1 || flags === 3) {
			try {
				payload = gunzipSync(payload);
			} catch {}
		}
		frames.push(Buffer.from(payload));
	}
	return frames;
}
