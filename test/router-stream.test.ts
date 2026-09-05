import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterRequestState } from "../src/extensions/router/state.ts";
import { sanitizeInputItemsForCodex, streamRouterCodex } from "../src/extensions/router/stream.ts";
import type { CodexModelConfig } from "../src/extensions/router/types.ts";

describe("router Codex payload sanitization", () => {
	it("preserves prefixed replayed item ids and Codex continuity fields", () => {
		const input = [
			{
				type: "reasoning",
				id: "item_8eac24fc0537bfab7c7e0155",
				status: "completed",
				summary: [{ type: "summary_text", text: "reasoning" }],
				encrypted_content: "opaque-reasoning",
			},
			{
				type: "message",
				id: "msg_assistant",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "done", annotations: [] }],
			},
			{
				type: "function_call",
				id: "fc_call",
				call_id: "call_123",
				name: "read",
				arguments: "{}",
				status: "completed",
			},
			{
				type: "function_call_output",
				id: "fco_result",
				call_id: "call_123",
				output: "ok",
				status: "completed",
			},
			{
				type: "local_shell_call",
				id: "lsh_call",
				call_id: "call_456",
				status: "completed",
				action: { type: "exec", command: ["echo", "ok"] },
			},
			{
				type: "web_search_call",
				id: "ws_call",
				status: "completed",
			},
		];

		const originalIds = input.map((item) => item.id);
		sanitizeInputItemsForCodex(input);

		expect(input.map((item) => item.id)).toEqual(originalIds);
		expect(input[0]).toMatchObject({
			type: "reasoning",
			encrypted_content: "opaque-reasoning",
		});
		expect(input[0]).not.toHaveProperty("status");
		expect(input[1]).not.toHaveProperty("status");
		expect(input[1]?.content?.[0]).not.toHaveProperty("annotations");
		expect(input[2]).toMatchObject({ call_id: "call_123" });
		expect(input[2]).not.toHaveProperty("status");
		expect(input[3]).toMatchObject({ call_id: "call_123" });
		expect(input[3]).not.toHaveProperty("status");
		expect(input[4]).toMatchObject({ call_id: "call_456", status: "completed" });
		expect(input[5]).toMatchObject({ status: "completed" });
	});

	it("preserves ids that are semantic references rather than ResponseItem identities", () => {
		const input = [
			{ type: "item_reference", id: "rs_stored_reasoning" },
			{
				type: "local_shell_call_output",
				id: "lsh_originating_call",
				output: "ok",
				status: "completed",
			},
			{
				type: "message",
				id: "msg_assistant",
				role: "assistant",
				content: [{ type: "output_text", id: "nested_content_id", text: "done", annotations: [] }],
			},
			{ type: "relay_extension_item", id: "relay_semantic_id" },
		];

		sanitizeInputItemsForCodex(input);

		expect(input[0]).toEqual({ type: "item_reference", id: "rs_stored_reasoning" });
		expect(input[1]).toMatchObject({
			type: "local_shell_call_output",
			id: "lsh_originating_call",
			status: "completed",
		});
		expect(input[2]).toHaveProperty("id", "msg_assistant");
		expect(input[2]?.content?.[0]).toMatchObject({ id: "nested_content_id" });
		expect(input[2]?.content?.[0]).not.toHaveProperty("annotations");
		expect(input[3]).toEqual({ type: "relay_extension_item", id: "relay_semantic_id" });
	});

	it.each(["bare", "_missingprefix", "missingSuffix_", ""])("removes only unprefixed ResponseItem ids (%s)", (id) => {
		const input = [
			{ type: "reasoning", id },
			{ type: "function_call", id, call_id: "call_test" },
		];
		sanitizeInputItemsForCodex(input);
		for (const item of input) expect(item).not.toHaveProperty("id");
		expect(input[1]).toHaveProperty("call_id", "call_test");
	});

	it("ignores non-array payload input", () => {
		const input = { type: "reasoning", id: "item_reasoning" };

		sanitizeInputItemsForCodex(input);

		expect(input.id).toBe("item_reasoning");
	});
});

interface CapturedRequest {
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
	url?: string;
}
const context: Context = {
	systemPrompt: "Synthetic test instructions only.",
	messages: [{ role: "user", content: "Read the synthetic fixture.", timestamp: 1 }],
};
const output = [
	{
		type: "reasoning",
		id: "rs_fixture",
		summary: [{ type: "summary_text", text: "Inspect fixture" }],
		encrypted_content: "synthetic-encrypted-reasoning",
		status: "completed",
	},
	{
		type: "message",
		id: "msg_fixture",
		role: "assistant",
		phase: "commentary",
		content: [{ type: "output_text", text: "Reading fixture", annotations: [] }],
		status: "completed",
	},
	{
		type: "function_call",
		id: "fc_fixture",
		call_id: "call_fixture",
		name: "read",
		arguments: '{"path":"fixture.txt"}',
		status: "completed",
	},
];
function sse(items: Record<string, unknown>[] = []): string {
	const events = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
		...items.flatMap((item, index) => [
			{ type: "response.output_item.added", output_index: index, item },
			{ type: "response.output_item.done", output_index: index, item },
		]),
		{
			type: "response.completed",
			response: {
				id: "resp_fixture",
				status: "completed",
				output: items,
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		},
	];
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe("router Codex API-key SSE wire contract (public pi-ai adapter)", () => {
	let server: Server | undefined;
	let model: Model<"openai-responses">;
	let requests: CapturedRequest[];
	const options: SimpleStreamOptions = {
		apiKey: "synthetic-local-test-key",
		sessionId: "fixture-session",
		maxRetries: 0,
	};

	async function listen(
		reply: (response: ServerResponse, index: number) => void = (response) => {
			response.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": "fixture-turn-token" });
			response.end(sse());
		},
	): Promise<void> {
		requests = [];
		server = createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push({
					headers: request.headers,
					body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
					url: request.url,
				});
				reply(response, requests.length - 1);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", resolve);
		});
		const port = (server.address() as AddressInfo).port;
		model = {
			api: "openai-responses",
			provider: "router-test",
			id: "synthetic-model",
			name: "Synthetic",
			baseUrl: `http://127.0.0.1:${port}/v1`,
			reasoning: true,
			input: ["text"],
			contextWindow: 10000,
			maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}
	afterEach(async () => {
		vi.unstubAllEnvs();
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
		server = undefined;
	});

	it("sends Codex identity and normal Responses fields, not SDK/Pi identity or max-output limits", async () => {
		await listen();
		const onResponse = vi.fn();
		const state = new RouterRequestState("fixture-installation");
		const result = await streamRouterCodex(
			model,
			context,
			{
				...options,
				maxTokens: 47,
				reasoning: "high",
				onResponse,
				headers: { "X-Stainless-Test": "remove", "X-Pi-Test": "remove" },
			},
			{ state },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		const { body, headers, url } = requests[0];
		expect(url).toBe("/v1/responses");
		expect(headers["user-agent"]).toMatch(/^codex_cli_rs\/0\.153\.4 \(/);
		expect(headers.accept).toBe("text/event-stream");
		expect(headers.authorization).toBe("Bearer synthetic-local-test-key");
		expect(headers.originator).toBe("codex_cli_rs");
		expect(Object.keys(headers).filter((name) => /^(x-stainless-|x-pi-)/.test(name))).toEqual([]);
		expect(headers).not.toHaveProperty("session_id");
		expect(headers).not.toHaveProperty("x-session-affinity");
		expect(body).toMatchObject({
			instructions: context.systemPrompt,
			store: false,
			stream: true,
			tools: [],
			tool_choice: "auto",
			parallel_tool_calls: true,
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: "fixture-session",
			reasoning: { effort: "high", summary: "auto" },
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Read the synthetic fixture." }] },
			],
		});
		for (const field of ["max_output_tokens", "temperature", "prompt_cache_retention", "text"])
			expect(body).not.toHaveProperty(field);
		const metadata = JSON.parse(String(headers["x-codex-turn-metadata"]));
		expect(body.client_metadata).toMatchObject({
			"x-codex-installation-id": "fixture-installation",
			session_id: headers["session-id"],
			thread_id: headers["thread-id"],
			turn_id: metadata.turn_id,
			"x-codex-window-id": headers["x-codex-window-id"],
			"x-codex-turn-metadata": headers["x-codex-turn-metadata"],
		});
		expect(onResponse).toHaveBeenCalledTimes(1);
		expect(onResponse.mock.calls[0][0]).toMatchObject({
			status: 200,
			headers: { "x-codex-turn-state": "fixture-turn-token" },
		});
	});

	it("isolates SDK process headers while preserving explicitly configured routing headers", async () => {
		await listen();
		vi.stubEnv("OPENAI_ORG_ID", "unrelated-org");
		vi.stubEnv("OPENAI_PROJECT_ID", "unrelated-project");
		vi.stubEnv(
			"OPENAI_CUSTOM_HEADERS",
			"X-Unrelated-Secret: unrelated-secret\nX-Tenant: unwanted\nUser-Agent: unwanted",
		);
		await streamRouterCodex(model, context, options).result();
		for (const name of ["openai-organization", "openai-project", "x-unrelated-secret", "x-tenant"]) {
			expect(requests[0].headers).not.toHaveProperty(name);
		}
		await streamRouterCodex(model, context, {
			...options,
			headers: {
				"OpenAI-Organization": "explicit-org",
				"OpenAI-Project": "explicit-project",
				"X-Tenant": "explicit-tenant",
			},
		}).result();
		expect(requests[1].headers).toMatchObject({
			"openai-organization": "explicit-org",
			"openai-project": "explicit-project",
			"x-tenant": "explicit-tenant",
		});
		expect(requests[1].headers["user-agent"]).toMatch(/^codex_cli_rs\//);
	});

	it("preserves base URL query parameters after appending the Responses path", async () => {
		await listen();
		model.baseUrl += "?tenant=a%2Fb&note=hello%20world";
		expect((await streamRouterCodex(model, context, options).result()).stopReason).toBe("stop");
		expect(requests[0].url).toBe("/v1/responses?tenant=a%2Fb&note=hello%20world");
	});

	it.each([
		{
			reasoning: true,
			mapped: "low",
			codex: { reasoningSummary: null, verbosity: null, parallelToolCalls: false },
			expectedReasoning: { effort: "low" },
			text: undefined,
		},
		{
			reasoning: true,
			mapped: "persistent",
			codex: { reasoningSummary: "detailed", verbosity: "high" },
			expectedReasoning: { effort: "disabled", summary: "detailed" },
			text: { verbosity: "high" },
		},
		{ reasoning: false, mapped: "high", codex: {}, expectedReasoning: {}, text: undefined },
	] satisfies Array<{
		reasoning: boolean;
		mapped: string;
		codex: CodexModelConfig;
		expectedReasoning: Record<string, string>;
		text?: { verbosity: string };
	}>)(
		"honors effort maps and explicit summary/verbosity/parallel rules (%#)",
		async ({ reasoning, mapped, codex, expectedReasoning, text }) => {
			await listen();
			model = { ...model, reasoning, thinkingLevelMap: { high: mapped } };
			const result = await streamRouterCodex(model, context, { ...options, reasoning: "high" }, { codex }).result();
			expect(result.stopReason).toBe("stop");
			expect(requests[0].body.reasoning).toEqual(expectedReasoning);
			expect(requests[0].body.text).toEqual(text);
			expect(requests[0].body.parallel_tool_calls).toBe(codex.parallelToolCalls ?? true);
		},
	);

	it("replays encrypted reasoning, prefixed IDs, phase and tool call results over real multi-turn SSE", async () => {
		await listen((response, index) => {
			response.writeHead(200, { "content-type": "text/event-stream", "x-codex-turn-state": `token-${index}` });
			response.end(sse(index === 0 ? output : []));
		});
		const state = new RouterRequestState("fixture-installation");
		const toolContext: Context = {
			...context,
			tools: [{ name: "read", description: "Read fixture", parameters: Type.Object({ path: Type.String() }) }],
		};
		const assistant = await streamRouterCodex(model, toolContext, options, { state }).result();
		expect(assistant.stopReason).toBe("toolUse");
		expect(assistant.content).toEqual(
			expect.arrayContaining([
				{ type: "toolCall", id: "call_fixture|fc_fixture", name: "read", arguments: { path: "fixture.txt" } },
			]),
		);
		const continuation: Context = {
			...toolContext,
			messages: [
				...context.messages,
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_fixture|fc_fixture",
					toolName: "read",
					content: [{ type: "text", text: "synthetic result" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const before = structuredClone(continuation);
		expect((await streamRouterCodex(model, continuation, options, { state }).result()).stopReason).toBe("stop");
		expect(continuation).toEqual(before);
		expect(requests[0].body.tools).toEqual([
			{
				type: "function",
				name: "read",
				description: "Read fixture",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		]);
		expect(requests[1].body.input).toEqual(
			expect.arrayContaining([
				{
					type: "reasoning",
					id: "rs_fixture",
					summary: [{ type: "summary_text", text: "Inspect fixture" }],
					encrypted_content: "synthetic-encrypted-reasoning",
				},
				{
					type: "message",
					id: "msg_fixture",
					role: "assistant",
					phase: "commentary",
					content: [{ type: "output_text", text: "Reading fixture" }],
				},
				{
					type: "function_call",
					id: "fc_fixture",
					call_id: "call_fixture",
					name: "read",
					arguments: '{"path":"fixture.txt"}',
				},
				{ type: "function_call_output", call_id: "call_fixture", output: "synthetic result" },
			]),
		);
		expect(requests[1].headers["x-codex-turn-state"]).toBe("token-0");
		expect(requests[1].body.client_metadata).toEqual(requests[0].body.client_metadata);
		await streamRouterCodex(model, continuation, options, { state }).result();
		expect(requests[2].headers["x-codex-turn-state"]).toBe("token-0");
		await streamRouterCodex(
			model,
			{ ...continuation, messages: [...continuation.messages, { role: "user", content: "New task", timestamp: 3 }] },
			options,
			{ state },
		).result();
		expect(requests[3].headers).not.toHaveProperty("x-codex-turn-state");
		expect(requests[3].body.client_metadata).not.toEqual(requests[0].body.client_metadata);
	});

	it("honors async before-request payload replacement after shaping", async () => {
		await listen();
		const onPayload = vi.fn(async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			instructions: "Replaced by hook",
			tool_choice: "none",
			parallel_tool_calls: false,
		}));
		expect((await streamRouterCodex(model, context, { ...options, onPayload }).result()).stopReason).toBe("stop");
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(requests[0].body).toMatchObject({
			instructions: "Replaced by hook",
			tool_choice: "none",
			parallel_tool_calls: false,
		});
	});

	it.each([400, 401, 429, 500])(
		"calls the response callback exactly once on HTTP %i without retry",
		async (status) => {
			await listen((response) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "Synthetic failure" } }));
			});
			const onResponse = vi.fn();
			const result = await streamRouterCodex(model, context, { ...options, onResponse }).result();
			expect(result.stopReason).toBe("error");
			expect(requests).toHaveLength(1);
			expect(onResponse).toHaveBeenCalledTimes(1);
			expect(onResponse.mock.calls[0][0]).toMatchObject({ status });
		},
	);

	it("reports an SSE error while observing its successful HTTP response only once", async () => {
		await listen((response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				'event: error\ndata: {"type":"error","code":"fixture_error","message":"Synthetic stream failure"}\n\n',
			);
		});
		const onResponse = vi.fn();
		const result = await streamRouterCodex(model, context, { ...options, onResponse }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Synthetic stream failure");
		expect(onResponse).toHaveBeenCalledTimes(1);
	});

	it("cancels an in-flight SSE request without retry or duplicate response callbacks", async () => {
		await listen((response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_cancel"}}\n\n',
			);
		});
		const controller = new AbortController();
		const onResponse = vi.fn(() => controller.abort());
		const result = await streamRouterCodex(model, context, {
			...options,
			signal: controller.signal,
			onResponse,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(requests).toHaveLength(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
	});
});
