/**
 * The two Devin (Windsurf) endpoints the search tools call. Both authenticate with the API key
 * inside the request body; neither needs a JWT exchange, a rate-limit preflight, or host details.
 *
 * - `GetDevstralStream` is one turn of the SWE-grep planner: a Connect-streaming protobuf request
 *   carrying a chat transcript and tool schemas, answered by one text completion.
 * - `GetWebSearchResults` is a Connect-unary JSON request answered by `{ results: [...] }`.
 *
 * There is no published schema. The field numbers and the client identity below are the minimum
 * the backend accepts; dropping any of them makes it answer `invalid_argument`.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { readResponseBytesBounded, readResponseTextBounded } from "../../utils/http-response.ts";

const SERVICE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const APP = "windsurf";
const APP_VERSION = "1.48.2";
const LANGUAGE_SERVER_VERSION = "1.9544.35";
const WEB_CLIENT_VERSION = "1.9600.41";
const TIMEOUT_MS = 30_000;

/**
 * Read ceilings, one per body shape, so a hostile or broken backend cannot be read unbounded. An
 * error is a short JSON status; a web search returns at most ten results with excerpts; the planner
 * streams a whole turn of transcript. The planner budget is also a decompressed-text budget.
 */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const WEB_RESULTS_MAX_BYTES = 2 * 1024 * 1024;
const PLANNER_MAX_BYTES = 8 * 1024 * 1024;
const PLANNER_MAX_TEXT_BYTES = 8 * 1024 * 1024;

export class DevinError extends Error {
	override name = "DevinError";
}

/** The credential is missing, revoked, or malformed; only signing in again fixes it. */
export class DevinAuthError extends DevinError {
	override name = "DevinAuthError";
}

/** A POST and the signal that bounds reading its body, shared with the request's timeout. */
interface DevinResponse {
	response: Response;
	signal: AbortSignal;
}

function errorFor(code: string | number, message = ""): DevinError {
	if (code === 401 || code === 403 || code === "unauthenticated" || code === "permission_denied") {
		return new DevinAuthError("Devin rejected the credential.");
	}
	if (code === 429 || code === "resource_exhausted") {
		return new DevinError("Devin rate-limited the request. Wait a moment and retry.");
	}
	return new DevinError(`Devin request failed (${code}${message ? `: ${message}` : ""}).`);
}

async function post(url: string, init: RequestInit, signal?: AbortSignal): Promise<DevinResponse> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	// Reading the body shares the request's budget, so a slow body cannot outlive the timeout.
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			method: "POST",
			redirect: "error",
			signal: requestSignal,
		});
	} catch (e) {
		if (signal?.aborted) throw e;
		throw new DevinError(timeout.aborted ? "Devin did not answer in time." : `Could not reach Devin: ${String(e)}`);
	}
	if (!response.ok) {
		const body = await readErrorBody(response, requestSignal);
		throw errorFor(body?.code ?? response.status, body?.message);
	}
	return { response, signal: requestSignal };
}

/** The status JSON of a failed call, bounded; an unreadable body leaves the HTTP status to speak. */
async function readErrorBody(
	response: Response,
	signal: AbortSignal,
): Promise<{ code?: string | number; message?: string } | undefined> {
	let text: string;
	try {
		text = await readResponseTextBounded(response, {
			maxBytes: ERROR_BODY_MAX_BYTES,
			overflowMessage: "Devin sent an oversized error body",
			signal,
		});
	} catch (error) {
		// A cancelled or timed-out read is the caller's own outcome, not a status to translate.
		if (signal.aborted) throw error;
		return undefined;
	}
	try {
		const body = JSON.parse(text) as { code?: unknown; message?: unknown } | null;
		if (!body || typeof body !== "object") return undefined;
		const code = typeof body.code === "string" || typeof body.code === "number" ? body.code : undefined;
		const message = typeof body.message === "string" ? body.message : undefined;
		return code === undefined && message === undefined ? undefined : { code, message };
	} catch {
		return undefined;
	}
}

// --- Protobuf, just enough for these messages ---

function varint(value: number): number[] {
	const bytes: number[] = [];
	while (value > 0x7f) {
		bytes.push((value & 0x7f) | 0x80);
		value >>>= 7;
	}
	bytes.push(value);
	return bytes;
}

function field(no: number, value: string | number | Buffer): Buffer {
	if (typeof value === "number") return Buffer.from([...varint(no << 3), ...varint(value)]);
	const data = typeof value === "string" ? Buffer.from(value, "utf-8") : value;
	return Buffer.concat([Buffer.from([...varint((no << 3) | 2), ...varint(data.length)]), data]);
}

/**
 * The length-delimited values of field `no` at the top level of `data`. Every tag, varint, and
 * length is checked, so a truncated or hostile payload fails here instead of yielding a short
 * answer: field 0, group wire types, and overlong or unterminated varints are all malformed.
 */
function readField(data: Uint8Array, no: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	let i = 0;
	/** A base-128 varint of at most ten bytes; running out of data means it was never terminated. */
	const readVarint = (): number => {
		let value = 0;
		for (let byte = 0; byte < 10; byte++) {
			if (i >= data.length) throw malformed();
			const b = data[i++]!;
			value += (b & 0x7f) * 2 ** (byte * 7);
			if (!(b & 0x80)) return value;
		}
		throw malformed();
	};
	const skip = (bytes: number): void => {
		if (i + bytes > data.length) throw malformed();
		i += bytes;
	};
	while (i < data.length) {
		const tag = readVarint();
		const field = tag >>> 3;
		if (field === 0) throw malformed();
		const wire = tag & 7;
		if (wire === 0) readVarint();
		else if (wire === 1) skip(8);
		else if (wire === 5) skip(4);
		else if (wire === 2) {
			const length = readVarint();
			if (i + length > data.length) throw malformed();
			if (field === no) out.push(data.subarray(i, i + length));
			i += length;
		} else throw malformed();
	}
	return out;
}

function malformed(): DevinError {
	return new DevinError("Devin sent a malformed protobuf message.");
}

// --- Planner turn ---

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** On an assistant message: the tool call it made. */
	call?: { id: string; name: string; arguments: string };
	/** On a tool message: the id of the call it answers. */
	callId?: string;
}

const ROLE = { user: 1, assistant: 2, tool: 4, system: 5 } as const;

export function encodeChatRequest(apiKey: string, messages: ChatMessage[], tools: string): Buffer {
	const metadata = Buffer.concat([
		field(1, APP),
		field(2, APP_VERSION),
		field(3, apiKey),
		field(7, LANGUAGE_SERVER_VERSION),
	]);
	const parts = [field(1, metadata)];
	for (const m of messages) {
		const msg = [field(2, ROLE[m.role]), field(3, m.content)];
		if (m.call) {
			msg.push(field(6, Buffer.concat([field(1, m.call.id), field(2, m.call.name), field(3, m.call.arguments)])));
		}
		if (m.callId) msg.push(field(7, m.callId));
		parts.push(field(2, Buffer.concat(msg)));
	}
	parts.push(field(3, tools));
	return Buffer.concat(parts);
}

/**
 * Connect streaming envelopes: a flags byte (bit 0 gzip, bit 1 end-of-stream) and a big-endian
 * length. Data frames carry text chunks in field 2; the end frame is JSON that names an error, if
 * any. Bits 2..7 of the flags byte are unused, and every header, length, and varint is checked.
 */
const FRAME_HEADER_BYTES = 5;
const RESERVED_FLAGS = 0xfc;

export function decodeChatResponse(body: Buffer): string {
	const decoder = new TextDecoder();
	let text = "";
	let textBytes = 0;
	let i = 0;
	while (i < body.length) {
		if (i + FRAME_HEADER_BYTES > body.length) {
			throw new DevinError("Devin sent a truncated planner frame.");
		}
		const flags = body[i]!;
		if (flags & RESERVED_FLAGS) {
			throw new DevinError("Devin sent a planner frame with reserved flags.");
		}
		const length = body.readUInt32BE(i + 1);
		i += FRAME_HEADER_BYTES;
		if (i + length > body.length) {
			throw new DevinError("Devin sent a truncated planner frame.");
		}
		let payload = body.subarray(i, i + length);
		i += length;
		if (flags & 1) {
			// A budget per frame as well as in total: gzip can expand a small frame past memory.
			try {
				payload = gunzipSync(payload, { maxOutputLength: Math.max(1, PLANNER_MAX_TEXT_BYTES - textBytes + 1) });
			} catch (error) {
				throw error instanceof RangeError
					? new DevinError("Devin's planner reply was too large.")
					: new DevinError("Devin sent a malformed planner frame.");
			}
		}
		if (flags & 2) {
			let end: { error?: { code?: string; message?: string } };
			try {
				end = JSON.parse(payload.toString("utf-8") || "{}") as { error?: { code?: string; message?: string } };
			} catch {
				throw new DevinError("Devin sent a malformed planner end frame.");
			}
			if (end?.error) throw errorFor(end.error.code ?? "unknown", end.error.message);
			continue;
		}
		for (const chunk of readField(payload, 2)) {
			text += decoder.decode(chunk, { stream: true });
			textBytes += chunk.length;
		}
		if (textBytes > PLANNER_MAX_TEXT_BYTES) {
			throw new DevinError("Devin's planner reply was too large.");
		}
	}
	text += decoder.decode();
	return text;
}

export async function chat(
	apiKey: string,
	messages: ChatMessage[],
	tools: string,
	signal?: AbortSignal,
): Promise<string> {
	const message = gzipSync(encodeChatRequest(apiKey, messages, tools));
	const envelope = Buffer.alloc(5);
	envelope[0] = 1;
	envelope.writeUInt32BE(message.length, 1);
	const { response, signal: requestSignal } = await post(
		`${SERVICE}/GetDevstralStream`,
		{
			headers: {
				"Content-Type": "application/connect+proto",
				"Connect-Protocol-Version": "1",
				"Connect-Content-Encoding": "gzip",
				"Connect-Accept-Encoding": "gzip",
				"Connect-Timeout-Ms": String(TIMEOUT_MS),
			},
			body: new Uint8Array(Buffer.concat([envelope, message])),
		},
		signal,
	);
	const bytes = await readResponseBytesBounded(response, {
		maxBytes: PLANNER_MAX_BYTES,
		overflowMessage: `Devin's planner reply exceeded ${PLANNER_MAX_BYTES} bytes`,
		signal: requestSignal,
	});
	return decodeChatResponse(Buffer.from(bytes));
}

// --- Web search ---

export interface WebResult {
	url: string;
	title?: string;
	/** Query-relevant excerpts of the page, joined by `...`; up to about 4,000 characters. */
	summary?: string;
}

export async function webSearch(
	apiKey: string,
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<WebResult[]> {
	const { response, signal: requestSignal } = await post(
		`${SERVICE}/GetWebSearchResults`,
		{
			headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
			body: JSON.stringify({
				metadata: { apiKey, ideName: APP, ideVersion: WEB_CLIENT_VERSION, extensionVersion: WEB_CLIENT_VERSION },
				query,
				limit,
			}),
		},
		signal,
	);
	const text = await readResponseTextBounded(response, {
		maxBytes: WEB_RESULTS_MAX_BYTES,
		overflowMessage: `Devin's web search reply exceeded ${WEB_RESULTS_MAX_BYTES} bytes`,
		signal: requestSignal,
	});
	return parseWebResults(text);
}

function parseWebResults(text: string): WebResult[] {
	let results: unknown;
	try {
		results = (JSON.parse(text) as { results?: unknown }).results;
	} catch {
		throw new DevinError("Devin returned a malformed web search response.");
	}
	if (!Array.isArray(results)) throw new DevinError("Devin returned a malformed web search response.");
	return results.flatMap((row): WebResult[] => {
		const { url, title, summary } = (row ?? {}) as Record<string, unknown>;
		if (typeof url !== "string" || !isWebUrl(url)) return [];
		return [
			{
				url,
				...(typeof title === "string" && title.trim() ? { title: title.trim() } : {}),
				...(typeof summary === "string" && summary.trim() ? { summary: summary.trim() } : {}),
			},
		];
	});
}

function isWebUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
	} catch {
		return false;
	}
}
