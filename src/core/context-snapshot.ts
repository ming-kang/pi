import { isDeepStrictEqual } from "node:util";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ModelsSimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";
import { convertToLlm } from "./messages.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Detached model input and request configuration. Contains no tool executors or session writer. */
export interface ContextSnapshot {
	capturedAt: number;
	sessionId: string;
	leafId: string | null;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	systemPrompt: string;
	messages: Message[];
	tools: Tool[];
	/** Includes provider hooks and header transforms, but never the main run's abort signal. */
	streamOptions: ModelsSimpleStreamOptions;
}

function convertWithImagePolicy(messages: AgentMessage[], blockImages: boolean): Message[] {
	const converted = convertToLlm(messages);
	if (!blockImages) return converted;
	return converted.map((message) => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		if (!Array.isArray(message.content) || !message.content.some((part) => part.type === "image")) return message;
		const content = message.content
			.map((part) => (part.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : part))
			.filter(
				(part, i, all) =>
					!(
						part.type === "text" &&
						part.text === "Image reading is disabled." &&
						i > 0 &&
						all[i - 1].type === "text" &&
						(all[i - 1] as { type: "text"; text: string }).text === part.text
					),
			);
		return { ...message, content };
	});
}

interface PreparedSource {
	messages: AgentMessage[];
	runner: ExtensionRunner | undefined;
}

/**
 * Records the actual pre-provider message prefix, after context hooks and image policy.
 * A snapshot can reuse it and convert only newly settled messages. In particular, a
 * time-dependent context hook is not rerun over an already prepared cache prefix.
 */
export class ContextSnapshotCapture {
	private readonly settings: SettingsManager;
	private readonly runnerRef: { current?: ExtensionRunner };
	private readonly pending = new WeakMap<AgentMessage[], PreparedSource>();
	private prepared: { source: PreparedSource; messages: Message[]; blockImages: boolean } | undefined;

	constructor(settings: SettingsManager, runnerRef: { current?: ExtensionRunner }) {
		this.settings = settings;
		this.runnerRef = runnerRef;
	}

	transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
		const runner = this.runnerRef.current;
		const source = { messages: structuredClone(messages), runner };
		const transformed = runner ? await runner.emitContext(messages) : messages;
		this.pending.set(transformed, source);
		return transformed;
	};

	convertToLlm = (messages: AgentMessage[]): Message[] => {
		const blockImages = this.settings.getBlockImages();
		const converted = convertWithImagePolicy(messages, blockImages);
		const source = this.pending.get(messages);
		if (source) {
			this.pending.delete(messages);
			this.prepared = { source, messages: structuredClone(converted), blockImages };
		}
		return converted;
	};

	capture = async (messages: AgentMessage[]): Promise<Message[]> => {
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
				...convertWithImagePolicy(messages.slice(prepared.source.messages.length), blockImages),
			];
		}
		// No request yet, or the branch/context policy changed. Prepare this detached
		// snapshot once; it never replaces the prefix recorded from the main request.
		const transformed = runner ? await runner.emitContext(messages) : messages;
		return structuredClone(convertWithImagePolicy(transformed, blockImages));
	};
}
