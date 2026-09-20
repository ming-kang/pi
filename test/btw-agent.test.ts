import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Context,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type Models,
	type ModelsSimpleStreamOptions,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { BtwAgent } from "../src/extensions/btw/agent.ts";
import {
	BTW_REMINDER,
	MAX_MODEL_STEPS,
	MAX_QUESTION_CHARS,
	MAX_QUESTIONS,
	TOOL_DENIAL,
	UNKNOWN_TOOL_RESULT,
} from "../src/extensions/btw/constants.ts";
import { createBtwMessages } from "../src/extensions/btw/snapshot.ts";
import { type BtwRequest, btwDone, btwPending, btwResponse, btwSnapshot } from "./helpers/btw.ts";

/** Split the transcript back into the prompt, conversation, and tools the provider resolves. */
function copyRequest(context: Context, options?: ModelsSimpleStreamOptions): BtwRequest {
	const { messages } = normalizeContext(context);
	const request: Context = {
		systemPrompt: getCurrentSystemPrompt(messages),
		messages: messages.filter((message) => message.role !== "system"),
		tools: getCurrentTools(messages).map(({ name, description, parameters, constrainedSampling }) => ({
			name,
			description,
			parameters,
			constrainedSampling,
		})),
	};
	return { context: structuredClone(request), options };
}

describe("BTW native Agent", () => {
	it("preserves model, signed content, images, tool order and request affinity across follow-ups", async () => {
		const snapshot = btwSnapshot();
		snapshot.messages[0] = {
			role: "user",
			content: [
				{ type: "text", text: "image" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			],
			timestamp: 1,
		};
		snapshot.messages[1] = btwResponse("", {
			content: [
				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "signed-reasoning" },
				{ type: "text", text: "Main answer", textSignature: "signed-text" },
			],
			timestamp: 2,
		});
		const before = structuredClone(snapshot.messages);
		const requests: BtwRequest[] = [];
		const runtime: Pick<Models, "streamSimple"> = {
			streamSimple: (model, context, options) => {
				expect(model).toEqual(snapshot.model);
				requests.push(copyRequest(context, options));
				return btwDone(
					btwResponse(`side answer ${requests.length}`, {
						content: [
							{ type: "thinking", thinking: "side thinking", thinkingSignature: "side-signature" },
							{ type: "text", text: `side answer ${requests.length}` },
						],
					}),
				);
			},
		};
		const side = new BtwAgent(snapshot, runtime, () => {});
		await side.ask("first side question");
		// Main activity after opening cannot enter this conversation.
		snapshot.messages.push({ role: "user", content: "later main activity", timestamp: Date.now() });
		await side.ask("follow-up");
		for (const request of requests) {
			expect(request.context.systemPrompt).toBe(snapshot.systemPrompt);
			expect(request.context.messages.slice(0, 2)).toEqual(before);
			expect(request.context.tools?.map((tool) => tool.name)).toEqual(["write", "read"]);
			expect(request.context.tools?.[0]).toMatchObject(snapshot.tools[0]);
			expect(request.options).toMatchObject({
				sessionId: snapshot.sessionId,
				reasoning: "high",
				thinkingBudgets: { high: 4096 },
				timeoutMs: 1234,
				maxRetries: 2,
				transport: "sse",
			});
			expect(request.options).not.toHaveProperty("toolChoice");
			expect(JSON.stringify(request.context)).not.toContain("later main activity");
		}
		expect(requests[1].context.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: expect.arrayContaining([expect.objectContaining({ thinkingSignature: "side-signature" })]),
				}),
			]),
		);
		expect(JSON.stringify(requests[1].context)).toContain("first side question");
		expect(side.turns.map((turn) => turn.answer)).toEqual(["side answer 1", "side answer 2"]);
		expect(side.usage.cacheRead).toBe(200);
		side.dispose();
		expect(side.turns).toEqual([]);
	});

	it("denies tool execution through the native loop and recovers with an answer", async () => {
		const requests: BtwRequest[] = [];
		const runtime: Pick<Models, "streamSimple"> = {
			streamSimple: (_model, context, options) => {
				requests.push(copyRequest(context, options));
				return btwDone(
					requests.length === 1
						? btwResponse("", {
								stopReason: "toolUse",
								content: [
									{ type: "toolCall", id: "write-call", name: "write", arguments: { path: "forbidden.txt" } },
								],
							})
						: btwResponse("The snapshot already contains the answer."),
				);
			},
		};
		const snapshot = btwSnapshot();
		const side = new BtwAgent(snapshot, runtime, () => {});
		await side.ask("Explain this");
		expect(requests).toHaveLength(2);
		expect(requests[1].context.messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "write-call",
			isError: true,
			content: [{ type: "text", text: TOOL_DENIAL }],
		});
		expect(side.turns[0]).toMatchObject({ status: "done", answer: "The snapshot already contains the answer." });
		expect(side.blockedTools).toBe(1);
		side.dispose();
	});

	it("stops repeated tool requests at a bounded number of model steps", async () => {
		let requests = 0;
		const side = new BtwAgent(
			btwSnapshot(),
			{
				streamSimple: () => {
					requests++;
					return btwDone(
						btwResponse("", {
							stopReason: "toolUse",
							content: [{ type: "toolCall", id: `read-${requests}`, name: "read", arguments: { path: "file" } }],
						}),
					);
				},
			},
			() => {},
		);
		await side.ask("Try tools");
		expect(requests).toBe(MAX_MODEL_STEPS);
		expect(side.turns[0].notice).toContain("repeated tool requests");
		expect(side.busy).toBe(false);
		side.dispose();
	});

	it("cancels only the side Agent, keeps partial output, and waits for settlement before another turn", async () => {
		const snapshot = btwSnapshot();
		let mainSignal: AbortSignal | undefined;
		let mainStream: ReturnType<typeof btwPending> | undefined;
		const main = new Agent({
			initialState: { model: snapshot.model },
			sessionId: snapshot.sessionId,
			streamFn: (_model, _context, options) => {
				mainSignal = options?.signal;
				mainStream = btwPending(mainSignal);
				return mainStream.stream;
			},
		});
		let sideSignal: AbortSignal | undefined;
		let sideStream: ReturnType<typeof btwPending> | undefined;
		let count = 0;
		const side = new BtwAgent(
			snapshot,
			{
				streamSimple: (_model, _context, options) => {
					expect(options?.sessionId).toBe(snapshot.sessionId);
					if (++count > 1) return btwDone(btwResponse("next answer"));
					sideSignal = options?.signal;
					sideStream = btwPending(sideSignal);
					return sideStream.stream;
				},
			},
			() => {},
		);
		const mainRun = main.prompt("main running");
		const sideRun = side.ask("side running");
		await vi.waitFor(() => expect(sideStream).toBeDefined());
		sideStream!.text("Partial answer");
		await vi.waitFor(() => expect(side.turns[0].answer).toBe("Partial answer"));
		side.cancel();
		expect(side.validate("too early")).toContain("still answering");
		expect(sideSignal?.aborted).toBe(true);
		expect(mainSignal?.aborted).toBe(false);
		expect(main.state.isStreaming).toBe(true);
		await sideRun;
		expect(side.turns[0]).toMatchObject({ answer: "Partial answer", status: "cancelled" });
		await side.ask("continue side");
		expect(side.turns[1].answer).toBe("next answer");
		mainStream!.finish("Main completed independently");
		await mainRun;
		expect(main.state.messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "Main completed independently" }],
		});
		side.dispose();
	});

	it("rejects oversized questions, full context, and excessive follow-ups before a request", async () => {
		const streamSimple = vi.fn(() => btwDone(btwResponse("ok")));
		const side = new BtwAgent(btwSnapshot(), { streamSimple }, () => {});
		await expect(side.ask("x".repeat(MAX_QUESTION_CHARS + 1))).rejects.toThrow("characters");
		expect(streamSimple).not.toHaveBeenCalled();
		for (let i = 0; i < MAX_QUESTIONS; i++) await side.ask(`question ${i}`);
		await expect(side.ask("one more")).rejects.toThrow("conversation limit");
		expect(streamSimple).toHaveBeenCalledTimes(MAX_QUESTIONS);
		side.dispose();
		const snapshot = btwSnapshot();
		snapshot.messages.push(
			btwResponse("context", { usage: { ...btwResponse("").usage, totalTokens: snapshot.model.contextWindow } }),
		);
		const full = new BtwAgent(snapshot, { streamSimple }, () => {});
		await expect(full.ask("does not fit")).rejects.toThrow("context space");
		expect(streamSimple).toHaveBeenCalledTimes(MAX_QUESTIONS);
		full.dispose();
	});
});

describe("BTW snapshot tail", () => {
	it("preserves completed results and fills only the still-unknown result", () => {
		const messages: Message[] = [
			btwResponse("", {
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "done", name: "read", arguments: { path: "one" } },
					{ type: "toolCall", id: "pending", name: "read", arguments: { path: "two" } },
				],
			}),
			{
				role: "toolResult",
				toolCallId: "done",
				toolName: "read",
				content: [{ type: "text", text: "Actual result" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const snapshot = btwSnapshot({ messages });
		const result = createBtwMessages(snapshot);
		expect(result.slice(0, 2)).toEqual(messages);
		expect(result[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "pending",
			content: [{ type: "text", text: UNKNOWN_TOOL_RESULT }],
		});
		expect(result.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: BTW_REMINDER }] });
		expect(snapshot.messages).toHaveLength(2);
	});
});
