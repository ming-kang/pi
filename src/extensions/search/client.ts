import { randomUUID } from "node:crypto";
import { arch, cpus, hostname, version as osVersion, platform, release, totalmem } from "node:os";
import { gzipSync } from "node:zlib";
import { WS_APP } from "./constants.ts";
import { classifyError, type HttpishError, type SearchError } from "./errors.ts";
import { connectFrameDecode, connectFrameEncode, extractStrings, ProtobufEncoder } from "./protocol.ts";

// Host, app id, and protocol versions are Windsurf/Devin handshake fields: the
// backend keys its protocol behavior off them, so they are pinned rather than derived.
const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const WS_APP_VER = "1.48.2";
const WS_LS_VER = "1.9544.35";
/** Pinned protocol model id, not a user-facing model picker. */
const WS_MODEL = "MODEL_SWE_1_6_FAST";

const USER_AGENT = "connect-go/1.18.1 (go1.25.5)";
const SENTRY_PUBLIC_KEY = "b813f73488da69eedec534dba1029111";

export interface ChatMessage {
	/** 1=user, 2=assistant, 4=tool_result, 5=system */
	role: number;
	content: string;
	tool_call_id?: string;
	tool_name?: string;
	tool_args_json?: string;
	ref_call_id?: string;
}

const _jwtCache = new Map<string, { token: string; expiresAt: number }>();

function _getJwtExp(jwt: string): number {
	try {
		const parts = jwt.split(".");
		if (parts.length < 2) return 0;
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
		return payload.exp || 0;
	} catch {
		return 0;
	}
}

export async function getCachedJwt(apiKey: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const cached = _jwtCache.get(apiKey);
	if (cached && cached.expiresAt > now + 60) return cached.token;
	const token = await fetchJwt(apiKey);
	const exp = _getJwtExp(token);
	_jwtCache.set(apiKey, { token, expiresAt: exp || now + 3600 });
	return token;
}

export function clearJwtCache(apiKey?: string): void {
	if (apiKey) _jwtCache.delete(apiKey);
	else _jwtCache.clear();
}

export async function fetchJwt(apiKey: string): Promise<string> {
	const meta = new ProtobufEncoder();
	meta.writeString(1, WS_APP);
	meta.writeString(2, WS_APP_VER);
	meta.writeString(3, apiKey);
	meta.writeString(4, "zh-cn");
	meta.writeString(7, WS_LS_VER);
	meta.writeString(12, WS_APP);
	meta.writeBytes(30, Buffer.from([0x00, 0x01]));

	const outer = new ProtobufEncoder();
	outer.writeMessage(1, meta);

	const resp = await unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false);
	for (const s of extractStrings(resp)) {
		if (s.startsWith("eyJ") && s.includes(".")) return s;
	}
	throw new Error("Failed to extract JWT from GetUserJwt response");
}

function buildMetadata(apiKey: string, jwt: string): ProtobufEncoder {
	const meta = new ProtobufEncoder();
	meta.writeString(1, WS_APP);
	meta.writeString(2, WS_APP_VER);
	meta.writeString(3, apiKey);
	meta.writeString(4, "zh-cn");

	const plat = platform();
	const sysInfo = {
		Os: plat,
		Arch: arch(),
		Release: release(),
		Version: osVersion(),
		Machine: arch(),
		Nodename: hostname(),
		Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
		ProductVersion: "",
	};
	meta.writeString(5, JSON.stringify(sysInfo));
	meta.writeString(7, WS_LS_VER);

	const cpuList = cpus();
	const ncpu = cpuList.length || 4;
	const cpuInfo = {
		NumSockets: 1,
		NumCores: ncpu,
		NumThreads: ncpu,
		VendorID: "",
		Family: "0",
		Model: "0",
		ModelName: cpuList[0]?.model || "Unknown",
		Memory: totalmem(),
	};
	meta.writeString(8, JSON.stringify(cpuInfo));
	meta.writeString(12, WS_APP);
	meta.writeString(21, jwt);
	meta.writeBytes(30, Buffer.from([0x00, 0x01]));
	return meta;
}

function buildChatMessage(m: ChatMessage): ProtobufEncoder {
	const msg = new ProtobufEncoder();
	msg.writeVarint(2, m.role);
	msg.writeString(3, m.content);
	if (m.tool_call_id && m.tool_name && m.tool_args_json) {
		const tc = new ProtobufEncoder();
		tc.writeString(1, m.tool_call_id);
		tc.writeString(2, m.tool_name);
		tc.writeString(3, m.tool_args_json);
		msg.writeMessage(6, tc);
	}
	if (m.ref_call_id) msg.writeString(7, m.ref_call_id);
	return msg;
}

export function buildRequest(apiKey: string, jwt: string, messages: ChatMessage[], toolDefs: string): Buffer {
	const req = new ProtobufEncoder();
	req.writeMessage(1, buildMetadata(apiKey, jwt));
	for (const m of messages) req.writeMessage(2, buildChatMessage(m));
	req.writeString(3, toolDefs);
	return req.toBuffer();
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unaryRequest(url: string, protoBytes: Buffer, compress = true): Promise<Buffer> {
	const headers: Record<string, string> = {
		"Content-Type": "application/proto",
		"Connect-Protocol-Version": "1",
		"User-Agent": USER_AGENT,
		"Accept-Encoding": "gzip",
	};
	let body: Buffer;
	if (compress) {
		body = gzipSync(protoBytes);
		headers["Content-Encoding"] = "gzip";
	} else {
		body = protoBytes;
	}

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers,
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(30000),
		});
	} catch (e) {
		throw classifyError(e as HttpishError);
	}
	if (!resp.ok) {
		const err: HttpishError = new Error(`HTTP ${resp.status}`);
		err.status = resp.status;
		throw classifyError(err);
	}
	return Buffer.from(await resp.arrayBuffer());
}

export async function streamingRequest(protoBytes: Buffer, timeoutMs = 30000, maxRetries = 2): Promise<Buffer> {
	const frame = connectFrameEncode(protoBytes);
	const url = `${API_BASE}/GetDevstralStream`;
	const traceId = randomUUID().replace(/-/g, "");
	const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
	const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
	const abortMs = baseTimeoutMs + 5000;

	const headers: Record<string, string> = {
		"Content-Type": "application/connect+proto",
		"Connect-Protocol-Version": "1",
		"Connect-Accept-Encoding": "gzip",
		"Connect-Content-Encoding": "gzip",
		"Connect-Timeout-Ms": String(baseTimeoutMs),
		"User-Agent": USER_AGENT,
		"Accept-Encoding": "identity",
		Baggage:
			`sentry-release=language-server-windsurf@${WS_LS_VER},` +
			`sentry-environment=stable,sentry-sampled=false,` +
			`sentry-trace_id=${traceId},sentry-public_key=${SENTRY_PUBLIC_KEY}`,
		"Sentry-Trace": `${traceId}-${spanId}-0`,
	};

	let lastErr: HttpishError | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers,
				body: new Uint8Array(frame),
				signal: AbortSignal.timeout(abortMs),
			});
			if (!resp.ok) {
				const err: HttpishError = new Error(`HTTP ${resp.status}`);
				err.status = resp.status;
				if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
				lastErr = err;
				if (attempt < maxRetries) {
					await delay(1000 * (attempt + 1));
					continue;
				}
				throw err;
			}
			return Buffer.from(await resp.arrayBuffer());
		} catch (e) {
			const he = e as HttpishError;
			lastErr = he;
			if (he.status && he.status >= 400 && he.status < 500 && he.status !== 429) throw classifyError(he);
			if (attempt < maxRetries) {
				await delay(1000 * (attempt + 1));
			}
		}
	}
	throw classifyError(lastErr ?? new Error("streaming request failed"));
}

export async function checkRateLimit(apiKey: string, jwt: string): Promise<boolean> {
	const req = new ProtobufEncoder();
	req.writeMessage(1, buildMetadata(apiKey, jwt));
	req.writeString(3, WS_MODEL);
	try {
		await unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true);
		return true;
	} catch (e) {
		const fe = e as SearchError & HttpishError;
		if (fe.status === 429 || fe.code === "RATE_LIMITED") return false;
		return true; // fail open: never block search on a network hiccup
	}
}

function stripInvalidUtf8(buf: Buffer): string {
	return buf.toString("utf-8").replace(/�/g, "");
}

export function parseToolCall(text: string): [string, string, Record<string, unknown>] | null {
	text = text.replace(/<\/s>/g, "");
	const m = text.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
	if (!m) return null;

	const name = m[1]!;
	const raw = m[2]!.trim();

	let depth = 0;
	let end = 0;
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "{") depth++;
		else if (raw[i] === "}") {
			depth--;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	if (end === 0) end = raw.length;

	let args: Record<string, unknown>;
	const jsonCandidate = raw.slice(0, end);
	try {
		args = JSON.parse(jsonCandidate);
	} catch {
		try {
			args = JSON.parse(jsonCandidate.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":'));
		} catch {
			return null;
		}
	}
	const thinking = text.slice(0, m.index ?? 0).trim();
	return [thinking, name, args];
}

export function parseResponse(data: Buffer): [string, [string, Record<string, unknown>] | null] {
	const frames = connectFrameDecode(data);
	let allText = "";

	for (const frameData of frames) {
		try {
			const textCandidate = frameData.toString("utf-8");
			if (textCandidate.startsWith("{")) {
				const errObj = JSON.parse(textCandidate);
				if (errObj.error) {
					const code = errObj.error.code || "unknown";
					const msg = errObj.error.message || "";
					return [`[Error] ${code}: ${msg}`, null];
				}
			}
		} catch {}

		const rawText = stripInvalidUtf8(frameData);
		if (rawText.includes("[TOOL_CALLS]")) {
			allText = rawText;
			break;
		}
		for (const s of extractStrings(frameData)) {
			if (s.length > 10) allText += s;
		}
	}

	const parsed = parseToolCall(allText);
	if (parsed) {
		const [thinking, name, args] = parsed;
		return [thinking, [name, args]];
	}
	return [allText, null];
}
