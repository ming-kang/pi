import { isDeepStrictEqual } from "node:util";
import type { Agent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelsSimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
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
