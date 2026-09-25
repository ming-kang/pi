/** Offline provider for interactive CLI checks; see maintainers/interactive-testing.md. */
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@astralyn/pi";
import { Type } from "typebox";

function userText(context: Context): string {
	const message = [...context.messages].reverse().find((entry) => entry.role === "user");
	if (!message) return "";
	return typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export default function fixture(pi: ExtensionAPI): void {
	let requests = 0;
	let toolExecutions = 0;
	pi.registerTool({
		name: "fixture_wait", label: "Fixture wait", description: "Wait briefly for a terminal UI test.",
		parameters: Type.Object({ ms: Type.Integer({ minimum: 0, maximum: 20000 }) }),
		execute: async (_id, args, signal, onUpdate) => {
			toolExecutions++;
			onUpdate?.({ content: [{ type: "text", text: "Fixture tool is pending…" }], details: {} });
			await delay(args.ms, undefined, { signal });
			return { content: [{ type: "text", text: "Fixture tool finished.\nSecond result line.\nThird result line." }], details: {} };
		},
	});
	pi.registerCommand("fixture-status", {
		description: "Show offline terminal fixture counters",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Fixture: ${requests} requests, ${toolExecutions} tool executions, main idle=${ctx.isIdle()}`);
		},
	});
	pi.registerProvider("offline", {
		api: "openai-completions", baseUrl: "https://offline.invalid/v1", apiKey: "offline-fixture",
		models: [{ id: "fixture", name: "Offline fixture", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: (model, context, options?: SimpleStreamOptions) => {
			const request = ++requests;
			const question = userText(context);
			const side = context.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("<btw-reminder>"));
			const result: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], stopReason: "stop", timestamp: Date.now(),
				usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0, totalTokens: 1150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					stream.push({ type: "start", partial: result });
					if (question.startsWith("tools") && context.messages.at(-1)?.role !== "toolResult") {
						const call = { type: "toolCall" as const, id: `fixture-${request}`, name: "fixture_wait", arguments: { ms: question.includes("slow") ? 15000 : 2000 } };
						result.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: result });
						await delay(300, undefined, { signal: options?.signal });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: result });
						result.stopReason = "toolUse";
					} else {
						const thought = { type: "thinking" as const, thinking: "" };
						result.content.push(thought);
						stream.push({ type: "thinking_start", contentIndex: 0, partial: result });
						for (const text of ["检查上下文…\n", "保留工具定义…\n", "整理回答…\n"]) {
							await delay(200, undefined, { signal: options?.signal });
							thought.thinking += text;
							stream.push({ type: "thinking_delta", contentIndex: 0, delta: text, partial: result });
						}
						stream.push({ type: "thinking_end", contentIndex: 0, content: thought.thinking, partial: result });
						const text = { type: "text" as const, text: "" };
						result.content.push(text);
						stream.push({ type: "text_start", contentIndex: 1, partial: result });
						const length = question.includes("long") || question.includes("slow") ? 45 : 4;
						for (let line = 1; line <= length; line++) {
							await delay(question.includes("slow") ? 400 : 100, undefined, { signal: options?.signal });
							const delta = `${line === 1 ? `**${side ? "BTW" : "MAIN"} answer ${request}**\n\n` : ""}第 ${line} 行：中文、emoji 🙂 与 \`code\` 显示正常。${line % 3 === 0 ? "\n\n" : "\n"}`;
							text.text += delta;
							stream.push({ type: "text_delta", contentIndex: 1, delta, partial: result });
						}
						stream.push({ type: "text_end", contentIndex: 1, content: text.text, partial: result });
					}
					stream.push({ type: "done", reason: result.stopReason === "toolUse" ? "toolUse" : "stop", message: result });
				} catch (error) {
					result.stopReason = options?.signal?.aborted ? "aborted" : "error";
					result.errorMessage = error instanceof Error ? error.message : String(error);
					stream.push({ type: "error", reason: result.stopReason, error: result });
				} finally { stream.end(); }
			})();
			return stream;
		},
	});
}
