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

const SERVICE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const APP = "windsurf";
const APP_VERSION = "1.48.2";
const LANGUAGE_SERVER_VERSION = "1.9544.35";
const WEB_CLIENT_VERSION = "1.9600.41";
const TIMEOUT_MS = 30_000;

export class DevinError extends Error {
	override name = "DevinError";
}

/** The credential is missing, revoked, or malformed; only signing in again fixes it. */
export class DevinAuthError extends DevinError {
	override name = "DevinAuthError";
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

async function post(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			...init,
			method: "POST",
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (e) {
		if (signal?.aborted) throw e;
		throw new DevinError(timeout.aborted ? "Devin did not answer in time." : `Could not reach Devin: ${String(e)}`);
	}
	if (!response.ok) {
		const body = (await response.json().catch(() => undefined)) as { code?: string; message?: string } | undefined;
		throw errorFor(body?.code ?? response.status, body?.message);
	}
	return response;
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

/** The length-delimited values of field `no` at the top level of `data`. */
function readField(data: Buffer, no: number): Buffer[] {
	const out: Buffer[] = [];
	let i = 0;
	const readVarint = (): number => {
		let value = 0;
		for (let shift = 0; i < data.length; shift += 7) {
			const b = data[i++]!;
			value += (b & 0x7f) * 2 ** shift;
			if (!(b & 0x80)) break;
		}
		return value;
	};
	while (i < data.length) {
		const tag = readVarint();
		const wire = tag & 7;
		if (wire === 0) readVarint();
		else if (wire === 1) i += 8;
		else if (wire === 5) i += 4;
		else if (wire === 2) {
			const length = readVarint();
			if (tag >>> 3 === no) out.push(data.subarray(i, i + length));
			i += length;
		} else break;
	}
	return out;
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
 * Connect streaming envelopes: a flags byte (bit 0 gzip, bit 1 end-of-stream) and a length. Data
 * frames carry text chunks in field 2; the end frame is JSON that names an error, if any.
 */
export function decodeChatResponse(body: Buffer): string {
	let text = "";
	let i = 0;
	while (i + 5 <= body.length) {
		const flags = body[i]!;
		const length = body.readUInt32BE(i + 1);
		let payload = body.subarray(i + 5, i + 5 + length);
		i += 5 + length;
		if (flags & 1) payload = gunzipSync(payload);
		if (flags & 2) {
			const end = JSON.parse(payload.toString("utf-8") || "{}") as { error?: { code?: string; message?: string } };
			if (end.error) throw errorFor(end.error.code ?? "unknown", end.error.message);
			continue;
		}
		for (const chunk of readField(payload, 2)) text += chunk.toString("utf-8");
	}
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
	const response = await post(
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
	return decodeChatResponse(Buffer.from(await response.arrayBuffer()));
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
	const response = await post(
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
	const results = ((await response.json().catch(() => undefined)) as { results?: unknown } | undefined)?.results;
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
