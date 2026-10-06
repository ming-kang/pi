import { isDeepStrictEqual } from "node:util";
import type { Agent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	getCurrentSystemMessage,
	getSystemMessageText,
	type Message,
	type Model,
	type ModelsSimpleStreamOptions,
	type Tool,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Detached model input and request configuration. Contains no tool executors or session writer. */
export interface ContextSnapshot {
	capturedAt: number;
	sessionId: string;
	leafId: string | null;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/**
	 * The prompt replayed from the prepared transcript, which is the text the provider received.
	 * Before the first request it is the session's current prompt, which a consumer's Agent
	 * declares itself when `messages` carry no system message.
	 */
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
	/** Includes provider hooks and header transforms, but never the main run's abort signal. */
	streamOptions: ModelsSimpleStreamOptions;
}

/** Capture a session's stable state before any asynchronous context preparation. Never includes a partial stream. */
export async function captureContextSnapshot(
	session: Pick<AgentSession, "agent" | "model" | "sessionManager" | "systemPrompt" | "thinkingLevel">,
	source: ContextSnapshotSource | undefined,
): Promise<ContextSnapshot> {
	const model = session.model;
	if (!model) throw new Error("No model selected");
	const requestOptions = {
		sessionId: session.agent.sessionId ?? session.sessionManager.getSessionId(),
		transport: session.agent.transport,
		thinkingBudgets: structuredClone(session.agent.thinkingBudgets),
		maxRetryDelayMs: session.agent.maxRetryDelayMs,
		onPayload: session.agent.onPayload,
		onResponse: session.agent.onResponse,
	};
	const snapshot = {
		capturedAt: Date.now(),
		sessionId: session.sessionManager.getSessionId(),
		leafId: session.sessionManager.getLeafId(),
		model: structuredClone(model),
		thinkingLevel: session.thinkingLevel,
		tools: session.agent.state.tools.map(({ name, description, parameters, constrainedSampling }) => ({
			name,
			description,
			parameters: structuredClone(parameters),
			...(constrainedSampling === undefined ? {} : { constrainedSampling: structuredClone(constrainedSampling) }),
		})),
		streamOptions: source?.resolveStreamOptions(model, requestOptions) ?? requestOptions,
	};
	const currentSystemPrompt = session.systemPrompt;
	// The canonical projection is what the next request converts; the inspection cache may lag it.
	const messages = structuredClone(session.sessionManager.buildSessionProjection().messages);
	const convert = session.agent.convertToLlm;
	const transform = session.agent.transformContext;
	const prepared = source
		? await source.prepareMessages(messages)
		: await convert(transform ? await transform(messages) : messages);
	// The prepared transcript declares the prompt the provider received, including a forced
	// prompt projected for the last request; before the first request there is none yet.
	const declared = getCurrentSystemMessage(prepared);
	return {
		...snapshot,
		systemPrompt: declared ? getSystemMessageText(declared) : currentSystemPrompt,
		messages: structuredClone(prepared),
	};
}

/** What a session needs from the SDK to describe the request it would send next. */
export interface ContextSnapshotSource {
	/** Prepare `messages` exactly as the next request would, reusing the recorded main prefix. */
	prepareMessages(messages: AgentMessage[]): Promise<Message[]>;
	/** The stream options the SDK would send for `model`, including provider hooks and header transforms. */
	resolveStreamOptions(model: Model<Api>, options: ModelsSimpleStreamOptions): ModelsSimpleStreamOptions;
}

interface PreparedSource {
	messages: AgentMessage[];
	runner: ExtensionRunner | undefined;
}

/**
 * Records the actual pre-provider message prefix, after context hooks, the session's request
 * projections, and image policy. A snapshot can reuse it and convert only newly settled
 * messages. In particular, a time-dependent context hook is not rerun over an already
 * prepared cache prefix.
 *
 * The SDK's own `convertToLlm` and request-option builder stay where upstream defines them;
 * this class wraps the former and borrows the latter, so it never keeps a second copy of
 * either.
 */
export class ContextSnapshotCapture implements ContextSnapshotSource {
	private readonly settings: SettingsManager;
	private readonly runnerRef: { current?: ExtensionRunner };
	private readonly buildRequestOptions: ContextSnapshotSource["resolveStreamOptions"];
	private readonly pending = new WeakMap<AgentMessage[], PreparedSource>();
	private prepared: { source: PreparedSource; messages: Message[]; blockImages: boolean } | undefined;
	private agent: Agent | undefined;

	constructor(
		settings: SettingsManager,
		runnerRef: { current?: ExtensionRunner },
		buildRequestOptions: ContextSnapshotSource["resolveStreamOptions"],
	) {
		this.settings = settings;
		this.runnerRef = runnerRef;
		this.buildRequestOptions = buildRequestOptions;
	}

	/**
	 * Record the source of every request context. Install after all other `transformContext`
	 * wrappers so the recorded prefix is exactly the array the request converts; a wrapper
	 * installed later would return a different array and the prefix would never be reused.
	 */
	install(agent: Agent): void {
		this.agent = agent;
		const transform = agent.transformContext;
		agent.transformContext = async (messages, signal) => {
			const runner = this.runnerRef.current;
			const source = { messages: structuredClone(messages), runner };
			const transformed = transform ? await transform(messages, signal) : messages;
			this.pending.set(transformed, source);
			return transformed;
		};
		const convert = agent.convertToLlm;
		const record = (messages: AgentMessage[], converted: Message[]): Message[] => {
			const source = this.pending.get(messages);
			if (source) {
				this.pending.delete(messages);
				this.prepared = {
					source,
					messages: structuredClone(converted),
					blockImages: this.settings.getBlockImages(),
				};
			}
			return converted;
		};
		agent.convertToLlm = (messages) => {
			const converted = convert(messages);
			return Array.isArray(converted) ? record(messages, converted) : converted.then((all) => record(messages, all));
		};
	}

	resolveStreamOptions(model: Model<Api>, options: ModelsSimpleStreamOptions): ModelsSimpleStreamOptions {
		return this.buildRequestOptions(model, options);
	}

	async prepareMessages(messages: AgentMessage[]): Promise<Message[]> {
		const agent = this.agent;
		if (!agent) throw new Error("Context snapshot capture is not installed");
		const runner = this.runnerRef.current;
		const blockImages = this.settings.getBlockImages();
		const prepared = this.prepared;
		if (
			prepared &&
			prepared.source.runner === runner &&
			prepared.blockImages === blockImages &&
			isDeepStrictEqual(messages.slice(0, prepared.source.messages.length), prepared.source.messages)
		) {
			return [
				...structuredClone(prepared.messages),
				...(await agent.convertToLlm(messages.slice(prepared.source.messages.length))),
			];
		}
		// No request yet, or the branch/context policy changed. Prepare this detached
		// snapshot once; it never replaces the prefix recorded from the main request.
		const transformed = runner ? await runner.emitContext(messages) : messages;
		return structuredClone(await agent.convertToLlm(transformed));
	}
}
