import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function createLargeTool(text: string): AgentTool {
	return {
		name: "large",
		label: "Large",
		description: "Returns a large tool result.",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text }],
			details: {},
		}),
	};
}

function createStreamMessage(model: Model<any>, message: AssistantMessage, totalTokens: number): AssistantMessage {
	return {
		...message,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

function isSummarizationRequest(systemPrompt: string | undefined): boolean {
	return systemPrompt?.startsWith("You are a context summarization assistant.") ?? false;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("keeps the captured custom streamFn when auth resolution is still pending", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getCapturedStreamCallCount = useSummaryStreamFn(harness, "summary from captured stream");
		let markAuthStarted: () => void = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let releaseAuth: () => void = () => {};
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async () => {
			markAuthStarted();
			await authReleased;
			return undefined;
		});
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compaction = sessionInternals._runAutoCompaction("threshold", false);
		await authStarted;
		let replacementStreamCallCount = 0;
		harness.session.agent.streamFunction = (model) => {
			replacementStreamCallCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createStreamMessage(model, fauxAssistantMessage("summary from replacement stream"), 10);
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		releaseAuth();
		await compaction;

		expect(getCapturedStreamCallCount()).toBe(1);
		expect(replacementStreamCallCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.summary).toContain("summary from captured stream");
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("does not retry overflow recovery when retained context remains above the threshold", async () => {
		const sessionCompactWillRetry: boolean[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
					pi.on("session_compact", async (event) => {
						sessionCompactWillRetry.push(event.willRetry);
					});
				},
			],
		});
		harnesses.push(harness);
		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `old user ${"u".repeat(1_000)}` }],
			timestamp: now - 5_000,
		});
		harness.sessionManager.appendMessage(
			createStreamMessage(model, fauxAssistantMessage(`old assistant ${"a".repeat(1_000)}`), 700),
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "current turn" }],
			timestamp: now - 3_000,
		});
		harness.sessionManager.appendMessage(
			createStreamMessage(
				model,
				fauxAssistantMessage(fauxToolCall("large", {}, { id: "large-overflow" }), { stopReason: "toolUse" }),
				800,
			),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "large-overflow",
			toolName: "large",
			content: [{ type: "text", text: `oversized retained result ${"t".repeat(3_600)}` }],
			isError: false,
			timestamp: now - 1_000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const shouldContinue = await sessionInternals._runAutoCompaction("overflow", true);

		expect(shouldContinue).toBe(false);
		expect(sessionCompactWillRetry).toEqual([false]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			result: { summary: "overflow summary" },
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("remains above"),
		});
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, "postRun");
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("compacts a large completed tool batch before the next provider request", async () => {
		const oldUser = `old user ${"u".repeat(300)}`;
		const oldAssistant = `old assistant ${"a".repeat(300)}`;
		const toolOutput = `large tool output ${"t".repeat(300)}`;
		const summary = "mid-turn summary";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 200 } },
			tools: [createLargeTool(toolOutput)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const providerContexts: Array<{ systemPrompt?: string; messages: readonly AgentMessage[] }> = [];
		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			providerContexts.push(context);
			const stream = createAssistantMessageEventStream();
			const mainRequest = !isSummarizationRequest(context.systemPrompt);
			const requestNumber = mainRequest ? mainRequestCount++ : -1;
			const message =
				mainRequest && requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(oldAssistant), 700)
					: mainRequest && requestNumber === 1
						? createStreamMessage(
								model,
								fauxAssistantMessage(
									[fauxToolCall("large", {}, { id: "large-1" }), fauxToolCall("large", {}, { id: "large-2" })],
									{ stopReason: "toolUse" },
								),
								800,
							)
						: mainRequest
							? createStreamMessage(model, fauxAssistantMessage("done"), 200)
							: createStreamMessage(model, fauxAssistantMessage("unused summary"), 10);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(oldUser);
		await harness.session.prompt("use the tool");

		const mainContexts = providerContexts.filter((context) => !isSummarizationRequest(context.systemPrompt));
		expect(mainRequestCount).toBe(3);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			result: { summary },
		});
		expect(getMessageText(mainContexts[2]?.messages[0])).toContain(summary);
		expect(mainContexts[2]?.messages.some((message) => getMessageText(message).includes(oldUser))).toBe(false);
		expect(mainContexts[2]?.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(mainContexts[2]?.messages.some((message) => getMessageText(message).includes(toolOutput))).toBe(true);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("stops when successful mid-turn compaction leaves retained context above the threshold", async () => {
		const oldUser = `old user ${"u".repeat(1_000)}`;
		const oldAssistant = `old assistant ${"a".repeat(1_000)}`;
		const toolOutput = `oversized retained tool output ${"t".repeat(3_600)}`;
		const summary = "retained context is still large";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1_000 } },
			tools: [createLargeTool(toolOutput)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			const stream = createAssistantMessageEventStream();
			const requestNumber = isSummarizationRequest(context.systemPrompt) ? -1 : mainRequestCount++;
			const message =
				requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(oldAssistant), 700)
					: createStreamMessage(
							model,
							fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" }),
							800,
						);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(oldUser);
		await harness.session.prompt("use the tool");

		expect(mainRequestCount).toBe(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("remains above the configured auto-compaction threshold"),
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			result: { summary },
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("remains above"),
		});

		await expect(harness.session.prompt("do not send this oversized context")).rejects.toThrow(
			"remains above the configured auto-compaction threshold",
		);
		expect(mainRequestCount).toBe(2);
	});

	it("does not let a post-run queue bypass an oversized retained context", async () => {
		const oldUser = `old user ${"u".repeat(1_000)}`;
		const oldAssistant = `old assistant ${"a".repeat(1_000)}`;
		const oversizedAssistant = `oversized retained assistant ${"z".repeat(3_600)}`;
		const timings: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						timings.push(event.timing);
						return {
							compaction: {
								summary: "post-run summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				harness.session.agent.followUp({
					role: "custom",
					customType: "test",
					content: [{ type: "text", text: "queued after post-run compaction" }],
					display: false,
					timestamp: Date.now(),
				});
			}
		});

		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model) => {
			const stream = createAssistantMessageEventStream();
			const requestNumber = mainRequestCount++;
			const message =
				requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(oldAssistant), 700)
					: requestNumber === 1
						? createStreamMessage(model, fauxAssistantMessage(oversizedAssistant), 800)
						: createStreamMessage(model, fauxAssistantMessage("should not run"), 10);
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
			return stream;
		};

		await harness.session.prompt(oldUser);
		await harness.session.prompt("finish with a large response");
		unsubscribe();

		expect(mainRequestCount).toBe(2);
		expect(timings).toEqual(["postRun"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			willRetry: false,
			errorMessage: expect.stringContaining("remains above"),
		});
	});

	it("does not make another provider request when mid-turn compaction is cancelled", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 100 } },
			tools: [createLargeTool(`large tool output ${"t".repeat(300)}`)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (event.signal.aborted) {
							return { cancel: true };
						}
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		let unsubscribeCompactionStart: (() => void) | undefined;
		const compactionStarted = new Promise<void>((resolve) => {
			unsubscribeCompactionStart = harness.session.subscribe((event) => {
				if (event.type === "compaction_start") {
					unsubscribeCompactionStart?.();
					resolve();
				}
			});
		});

		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			const stream = createAssistantMessageEventStream();
			const requestNumber = isSummarizationRequest(context.systemPrompt) ? -1 : mainRequestCount++;
			const message =
				requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(`old assistant ${"a".repeat(300)}`), 700)
					: createStreamMessage(
							model,
							fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" }),
							800,
						);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(`old user ${"u".repeat(300)}`);
		const prompt = harness.session.prompt("use the tool");
		await compactionStarted;
		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued during compaction" }],
			display: false,
			timestamp: Date.now(),
		});
		harness.session.abortCompaction();
		await prompt;

		expect(mainRequestCount).toBe(2);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: true,
			result: undefined,
		});
		expect(harness.eventsOfType("turn_end").at(-1)).toMatchObject({
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: expect.stringContaining("Stopped before the next provider request"),
			},
		});
		expect(harness.eventsOfType("agent_end").at(-1)).toMatchObject({ willRetry: false });
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("Stopped before the next provider request"),
		});
	});

	it("does not make another provider request when mid-turn compaction fails", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 100 } },
			tools: [createLargeTool(`large tool output ${"t".repeat(300)}`)],
		});
		harnesses.push(harness);

		let mainRequestCount = 0;
		let summarizationRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			const stream = createAssistantMessageEventStream();
			const summarizationRequest = isSummarizationRequest(context.systemPrompt);
			if (summarizationRequest) {
				summarizationRequestCount++;
			}
			const requestNumber = summarizationRequest ? -1 : mainRequestCount++;
			const message = summarizationRequest
				? createStreamMessage(
						model,
						fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
						0,
					)
				: requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(`old assistant ${"a".repeat(300)}`), 700)
					: createStreamMessage(
							model,
							fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" }),
							860,
						);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(`old user ${"u".repeat(300)}`);
		await harness.session.prompt("use the tool");

		expect(mainRequestCount).toBe(2);
		expect(summarizationRequestCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			result: undefined,
			errorMessage: expect.stringContaining("summary failed"),
		});
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("Stopped before the next provider request"),
		});
	});

	it("stops safely when the configured recent context leaves nothing to compact", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 10_000 } },
			tools: [createLargeTool(`large tool output ${"t".repeat(300)}`)],
		});
		harnesses.push(harness);

		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			const stream = createAssistantMessageEventStream();
			const requestNumber = isSummarizationRequest(context.systemPrompt) ? -1 : mainRequestCount++;
			const message =
				requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(`old assistant ${"a".repeat(300)}`), 700)
					: createStreamMessage(
							model,
							fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" }),
							800,
						);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(`old user ${"u".repeat(300)}`);
		await harness.session.prompt("use the tool");

		expect(mainRequestCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			result: undefined,
			errorMessage: expect.stringContaining("Nothing to compact"),
		});
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("Stopped before the next provider request"),
		});
	});

	it("continues the run when an extension voluntarily cancels mid-turn compaction", async () => {
		const timings: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 100 } },
			tools: [createLargeTool(`large tool output ${"t".repeat(300)}`)],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						timings.push(event.timing);
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);

		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			const stream = createAssistantMessageEventStream();
			const requestNumber = isSummarizationRequest(context.systemPrompt) ? -1 : mainRequestCount++;
			const message =
				requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(`old assistant ${"a".repeat(300)}`), 700)
					: requestNumber === 1 || requestNumber === 2
						? createStreamMessage(
								model,
								fauxAssistantMessage(fauxToolCall("large", {}), { stopReason: "toolUse" }),
								800,
							)
						: createStreamMessage(model, fauxAssistantMessage("done"), 200);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(`old user ${"u".repeat(300)}`);
		await harness.session.prompt("use the tool");

		// The cancel hands the risk to the extension: the run continues, and the
		// second tool batch does not re-ask within the same run.
		expect(mainRequestCount).toBe(4);
		expect(timings).toEqual(["midTurn"]);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		const lastCompactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(lastCompactionEnd).toMatchObject({ reason: "threshold", aborted: true, result: undefined });
		expect(lastCompactionEnd).not.toHaveProperty("errorMessage");
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
	});

	it("compacts before continuing with queued follow-up messages", async () => {
		const oldUser = `old user ${"u".repeat(300)}`;
		const summary = "queued follow-up summary";
		const timings: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 850, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 100 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						timings.push(event.timing);
						return {
							compaction: {
								summary,
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);

		const providerContexts: Array<{ systemPrompt?: string; messages: readonly AgentMessage[] }> = [];
		let mainRequestCount = 0;
		harness.session.agent.streamFunction = (model, context) => {
			providerContexts.push(context);
			const stream = createAssistantMessageEventStream();
			const requestNumber = isSummarizationRequest(context.systemPrompt) ? -1 : mainRequestCount++;
			if (requestNumber === 1) {
				harness.session.agent.followUp({
					role: "custom",
					customType: "test",
					content: [{ type: "text", text: "queued follow-up" }],
					display: false,
					timestamp: Date.now(),
				});
			}
			const message =
				requestNumber === 0
					? createStreamMessage(model, fauxAssistantMessage(`old assistant ${"a".repeat(300)}`), 700)
					: requestNumber === 1
						? createStreamMessage(model, fauxAssistantMessage(`large assistant ${"z".repeat(300)}`), 860)
						: createStreamMessage(model, fauxAssistantMessage("done"), 200);
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({ type: "error", reason: message.stopReason, error: message });
				} else {
					stream.push({ type: "done", reason: message.stopReason, message });
				}
			});
			return stream;
		};

		await harness.session.prompt(oldUser);
		await harness.session.prompt("respond at length");
		// A turn without tool results still compacts before delivering queued messages.
		expect(mainRequestCount).toBe(3);
		expect(timings).toEqual(["midTurn"]);
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		const mainContexts = providerContexts.filter((context) => !isSummarizationRequest(context.systemPrompt));
		expect(getMessageText(mainContexts[2]?.messages[0])).toContain(summary);
		expect(mainContexts[2]?.messages.some((message) => getMessageText(message).includes(oldUser))).toBe(false);
		expect(mainContexts[2]?.messages.some((message) => getMessageText(message).includes("queued follow-up"))).toBe(
			true,
		);
		expect(getMessageText(harness.session.messages.at(-1))).toBe("done");
	});
});
