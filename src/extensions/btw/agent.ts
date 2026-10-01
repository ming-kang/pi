import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type AgentTurnDecision,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Models, Usage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextSnapshot } from "../../core/extensions/index.ts";
import {
	MAX_DISPLAY_CHARS,
	MAX_MODEL_STEPS,
	MAX_OUTPUT_RESERVE_TOKENS,
	MAX_QUESTION_CHARS,
	MAX_QUESTIONS,
	MAX_RESPONSE_CHARS,
	TOOL_DENIAL,
} from "./constants.ts";
import { createBtwMessages } from "./snapshot.ts";

export interface BtwTurn {
	question: string;
	answer: string;
	thinking: string;
	status: "streaming" | "cancelling" | "done" | "cancelled" | "error";
	notice?: string;
	startedAt: number;
	elapsedMs: number;
	firstAnswerMs?: number;
}

export interface BtwConversationState {
	busy: boolean;
	turns: readonly BtwTurn[];
	usage: Usage;
	latestCacheHitPercent: number | undefined;
	blockedTools: number;
}

interface ActiveQuestion {
	turn: BtwTurn;
	steps: number;
	completedAnswer: string;
	responseChars: number;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function displayText(text: string): string {
	return text.length <= MAX_DISPLAY_CHARS ? text : `${text.slice(0, MAX_DISPLAY_CHARS)}\n\n[Display truncated]`;
}

/** An in-memory native Agent. No SessionManager, real tool executors, or main-agent signal. */
export class BtwAgent implements BtwConversationState {
	readonly turns: BtwTurn[] = [];
	readonly usage = emptyUsage();
	latestCacheHitPercent: number | undefined;
	blockedTools = 0;
	private readonly agent: Agent;
	private readonly unsubscribe: () => void;
	private readonly onChange: () => void;
	private readonly inputBudget: number;
	private active?: ActiveQuestion;
	private disposed = false;

	constructor(snapshot: ContextSnapshot, runtime: Pick<Models, "streamSimple">, onChange: () => void) {
		this.onChange = onChange;
		const outputReserve = Math.min(
			MAX_OUTPUT_RESERVE_TOKENS,
			snapshot.model.maxTokens,
			Math.max(1024, Math.floor(snapshot.model.contextWindow / 8)),
		);
		// Leave room for the answer and estimation error; never trim the inherited prefix.
		this.inputBudget = snapshot.model.contextWindow - outputReserve - 4096;
		const tools: AgentTool[] = snapshot.tools.map((tool) => ({
			...structuredClone(tool),
			label: tool.name,
			execute: async () => {
				// Defense in depth: these objects never receive an original execute function.
				throw new Error(TOOL_DENIAL);
			},
		}));
		this.agent = new Agent({
			initialState: {
				model: snapshot.model,
				thinkingLevel: snapshot.thinkingLevel,
				systemPrompt: snapshot.systemPrompt,
				tools,
				messages: createBtwMessages(snapshot),
			},
			sessionId: snapshot.streamOptions.sessionId ?? snapshot.sessionId,
			transport: snapshot.streamOptions.transport,
			thinkingBudgets: snapshot.streamOptions.thinkingBudgets,
			maxRetryDelayMs: snapshot.streamOptions.maxRetryDelayMs,
			onPayload: snapshot.streamOptions.onPayload,
			onResponse: snapshot.streamOptions.onResponse,
			streamFn: (model, context, options) =>
				// Keep the parent's generation settings as well as its message prefix.
				// The model's native output ceiling and our response-size guard still bound output.
				runtime.streamSimple(model, context, { ...snapshot.streamOptions, ...options }),
			beforeToolCall: async () => ({ block: true, reason: TOOL_DENIAL }),
			finishTurn: ({ message, toolResults, context }): AgentTurnDecision | undefined => {
				const question = this.active;
				// Error and aborted responses are hard exits; the step budget only counts answered turns.
				if (!question || this.disposed || message.stopReason === "error" || message.stopReason === "aborted")
					return undefined;
				question.steps++;
				if (!toolResults.length) return undefined;
				if (question.steps >= MAX_MODEL_STEPS || !this.fits(context.messages)) {
					question.turn.status = "error";
					question.turn.notice =
						question.steps >= MAX_MODEL_STEPS
							? "Stopped after repeated tool requests. BTW can only answer from its snapshot."
							: "Context limit reached. Reopen /btw for a new conversation.";
					return { action: "end" };
				}
				return undefined;
			},
		});
		this.unsubscribe = this.agent.subscribe((event) => this.handleEvent(event));
	}

	get busy(): boolean {
		return this.active !== undefined;
	}

	private validate(text: string): string | undefined {
		if (this.disposed) return "This BTW conversation is closed.";
		if (this.busy) return "BTW is still answering. Your question is kept in the editor.";
		if (this.turns.length >= MAX_QUESTIONS) return "BTW conversation limit reached. Reopen /btw to start a new one.";
		if (text.length > MAX_QUESTION_CHARS)
			return `BTW questions are limited to ${MAX_QUESTION_CHARS.toLocaleString()} characters.`;
		const question: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
		if (!this.fits([...this.agent.state.messages, question])) {
			return "Not enough context space for this BTW question. Compact the main conversation, then reopen /btw.";
		}
		return undefined;
	}

	/** Accept synchronously so a rejected question stays in the editor, outside both agents' queues. */
	startQuestion(text: string): { error: string } | { completion: Promise<void> } {
		const error = this.validate(text);
		if (error) return { error };
		const question: ActiveQuestion = {
			turn: {
				question: text,
				answer: "",
				thinking: "",
				status: "streaming",
				startedAt: Date.now(),
				elapsedMs: 0,
			},
			steps: 0,
			completedAnswer: "",
			responseChars: 0,
		};
		this.active = question;
		this.turns.push(question.turn);
		return { completion: this.runQuestion(question) };
	}

	private async runQuestion({ turn }: ActiveQuestion): Promise<void> {
		try {
			this.onChange();
			await this.agent.prompt(turn.question);
			if (turn.status === "streaming") {
				turn.status = "done";
				if (!turn.answer) turn.notice = "The model returned no answer text.";
			} else if (turn.status === "cancelling") {
				turn.status = "cancelled";
			}
		} catch (error) {
			turn.status = "error";
			turn.notice = displayText(error instanceof Error ? error.message : String(error));
		} finally {
			// Cancellation remains busy until the native Agent has fully settled.
			this.active = undefined;
			turn.elapsedMs = Date.now() - turn.startedAt;
			if (this.disposed) this.agent.reset();
			else this.onChange();
		}
	}

	cancel(): void {
		if (!this.active || this.disposed) return;
		this.active.turn.status = "cancelling";
		this.agent.abort();
		this.onChange();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.agent.abort();
		this.turns.length = 0;
		if (!this.busy) this.agent.reset();
		// sessionId is cache affinity shared with main. Never clean up its provider resources here.
	}

	private fits(messages: AgentMessage[]): boolean {
		return (
			estimateContextTokens(
				normalizeContext({
					systemPrompt: this.agent.state.systemPrompt,
					tools: this.agent.state.tools,
					messages: messages.filter(
						(message): message is Message =>
							message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
				}),
			).tokens < this.inputBudget
		);
	}

	private handleEvent(event: AgentEvent): void {
		const question = this.active;
		if (
			this.disposed ||
			!question ||
			(event.type !== "message_update" && event.type !== "message_end") ||
			event.message.role !== "assistant"
		)
			return;
		const { turn } = question;
		const message = event.message;
		this.updateAnswer(question, message);
		if (event.type === "message_end") {
			question.completedAnswer = turn.answer;
			question.responseChars += message.content.reduce(
				(sum, part) =>
					sum +
					(part.type === "text"
						? part.text.length
						: part.type === "thinking"
							? part.thinking.length
							: JSON.stringify(part.arguments).length),
				0,
			);
			this.blockedTools += message.content.filter((part) => part.type === "toolCall").length;
			const usage = message.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			this.latestCacheHitPercent =
				(usage.cacheRead > 0 || usage.cacheWrite > 0) && promptTokens > 0
					? (usage.cacheRead / promptTokens) * 100
					: undefined;
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				this.usage[key] += usage[key];
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
				this.usage.cost[key] += usage.cost[key];
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				turn.status = message.stopReason === "aborted" ? "cancelled" : "error";
				turn.notice ??=
					message.stopReason === "aborted"
						? "Stopped. You can ask another question."
						: displayText(message.errorMessage ?? "The request failed.");
			}
		}
		this.onChange();
	}

	private updateAnswer(question: ActiveQuestion, message: AssistantMessage): void {
		const { turn } = question;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		const thinking = message.content
			.filter((part) => part.type === "thinking")
			.map((part) => part.thinking)
			.join("");
		if (text && turn.firstAnswerMs === undefined) turn.firstAnswerMs = Date.now() - turn.startedAt;
		turn.answer = displayText([question.completedAnswer, text].filter(Boolean).join("\n\n"));
		turn.thinking = thinking.slice(-2000);
		if (question.responseChars + JSON.stringify(message.content).length > MAX_RESPONSE_CHARS) {
			turn.notice = "Stopped at the BTW response size limit. You can ask a shorter follow-up.";
			this.agent.abort();
		}
	}
}
