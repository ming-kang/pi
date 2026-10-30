/**
 * transport.ts — one stateless MCP `tools/call` round trip to DeepWiki.
 *
 * DeepWiki's public endpoint issues no `Mcp-Session-Id`, so a session-bearing
 * `McpClient` would only add an initialize handshake to every uncached call.
 * The request therefore stays a single POST. Retry and abort semantics come from
 * `management-http`, body bounding from `http-response`, and JSON-RPC validation
 * from `@earendil-works/pi-mcp`. The SSE framing is the only local protocol code
 * because pi-mcp does not export its stream parser.
 */
import {
	isJsonRpcResponse,
	type JsonRpcResponse,
	McpError,
	parseJsonRpcMessage,
	type SupportedProtocolVersion,
} from "@earendil-works/pi-mcp";
import { readResponseTextBounded } from "../../utils/http-response.ts";
import { fetchWithRetry } from "../../utils/management-http.ts";

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
const REQUEST_TIMEOUT_MS = 45_000;
const RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_CHARS = 500;
/** Pinned, not pi-mcp's latest: this call never negotiates, so it sends the version DeepWiki is known to accept. */
const PROTOCOL_VERSION: SupportedProtocolVersion = "2024-11-05";

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`DeepWiki returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseJsonRpcResponse(value: unknown): JsonRpcResponse {
	const message = parseJsonRpcMessage(value);
	if (!isJsonRpcResponse(message)) throw new Error("DeepWiki returned a JSON-RPC message that is not a response");
	return message;
}

/** The first JSON-RPC response in an SSE body; notifications and `[DONE]` are skipped. */
function parseSseResponse(text: string): JsonRpcResponse {
	for (const block of text.split(/\r?\n\r?\n/)) {
		const data = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") continue;
		const message = parseJsonRpcMessage(parseJson(data));
		if (isJsonRpcResponse(message)) return message;
	}
	throw new Error("DeepWiki returned an empty event stream");
}

function truncate(text: string): string {
	return text.length <= ERROR_BODY_CHARS ? text : `${text.slice(0, ERROR_BODY_CHARS - 3)}...`;
}

/** Call a DeepWiki MCP tool and return the raw `result` of the JSON-RPC response. */
export async function callDeepWikiTool(
	toolName: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	// One budget for connect, retries, and body read; it is terminal, so a timeout is never retried.
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const response = await fetchWithRetry(DEEPWIKI_MCP_URL, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"MCP-Protocol-Version": PROTOCOL_VERSION,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: toolName, arguments: args },
			}),
			signal: requestSignal,
		});
		const text = await readResponseTextBounded(response, {
			maxBytes: RESPONSE_BODY_BYTES,
			overflowMessage: `DeepWiki response exceeded ${RESPONSE_BODY_BYTES} bytes`,
			signal: requestSignal,
		});
		if (!response.ok) throw new Error(`DeepWiki HTTP ${response.status}: ${truncate(text)}`);

		const isSse = response.headers.get("content-type")?.includes("text/event-stream");
		const message = isSse ? parseSseResponse(text) : parseJsonRpcResponse(parseJson(text));
		if ("error" in message) throw new McpError(message.error.code, message.error.message, message.error.data);
		return message.result;
	} catch (error) {
		if (signal?.aborted) throw new Error("DeepWiki request aborted");
		if (timeout.aborted) throw new Error(`DeepWiki request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
		throw error;
	}
}
