import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ContextSnapshot } from "../../src/core/extensions/index.ts";

export const btwModel: Model<"openai-completions"> = {
	id: "btw-fixture",
	name: "BTW fixture",
	api: "openai-completions",
	provider: "btw-fixture",
	baseUrl: "https://btw.invalid/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

export function btwResponse(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: btwModel.api,
		provider: btwModel.provider,
		model: btwModel.id,
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 10,
			output: 20,
			cacheRead: 100,
			cacheWrite: 30,
			totalTokens: 160,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.003, total: 0.034 },
		},
		...overrides,
	};
}

export function btwDone(message: AssistantMessage): AssistantMessageEventStream {
	if (message.stopReason === "pending") throw new Error("The fixture requires a terminal message");
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...message, content: [] } });
	if (message.stopReason === "aborted" || message.stopReason === "error") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
	} else stream.push({ type: "done", reason: message.stopReason, message });
	stream.end();
	return stream;
}

export function btwSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
	return {
		capturedAt: Date.now(),
		sessionId: "shared-main-session",
		leafId: "main-leaf",
		model: structuredClone(btwModel),
		thinkingLevel: "high",
		systemPrompt: "Original system prompt",
		messages: [
			{ role: "user", content: "Original main question", timestamp: 1 },
			btwResponse("Original main answer", { timestamp: 2 }),
		],
		tools: [
			{
				name: "write",
				description: "Write a file",
				parameters: Type.Object({ path: Type.String() }),
				constrainedSampling: false,
			},
			{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
		],
		streamOptions: {
			sessionId: "shared-main-session",
			transport: "sse",
			thinkingBudgets: { high: 4096 },
			timeoutMs: 1234,
			maxRetries: 2,
		},
		...overrides,
	};
}

export interface BtwRequest {
	context: Context;
	options?: ModelsSimpleStreamOptions;
}

/** A controllable native stream whose cancellation preserves already emitted text. */
export function btwPending(signal?: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	const message = btwResponse("");
	stream.push({ type: "start", partial: message });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	let ended = false;
	const finish = (text: string, aborted = false) => {
		if (ended) return;
		ended = true;
		signal?.removeEventListener("abort", onAbort);
		message.content = [{ type: "text", text }];
		message.stopReason = aborted ? "aborted" : "stop";
		if (aborted) stream.push({ type: "error", reason: "aborted", error: message });
		else stream.push({ type: "done", reason: "stop", message });
		stream.end();
	};
	const onAbort = () =>
		finish(
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
			true,
		);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		stream,
		finish,
		text(text: string) {
			if (ended) return;
			message.content = [{ type: "text", text }];
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		},
	};
}
