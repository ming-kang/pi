import type { Agent, AgentMessage, PrepareNextTurnContext, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import {
	isContextOverflow,
	isRecoverableLength,
	type RetryCallbacks,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "./agent-session.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	estimateTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import type {
	CompactionTiming,
	ExtensionRunner,
	SessionBeforeCompactResult,
	SessionCompactFailedEvent,
} from "./extensions/index.ts";
import type { CompactionEntry, SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export const CONTEXT_REMAINS_OVER_COMPACTION_THRESHOLD =
	"Estimated retained context remains above the configured auto-compaction threshold. Reduce compaction.keepRecentTokens, remove large retained content, or switch to a model with a larger context window before continuing.";
export const NOTHING_TO_COMPACT_WITHIN_KEEP_WINDOW =
	"Nothing to compact while preserving the configured recent context. Reduce compaction.keepRecentTokens, remove large retained content, or switch to a model with a larger context window before continuing.";
export const AUTO_COMPACTION_STOPPED_BEFORE_NEXT_PROVIDER =
	"Stopped before the next provider request because auto-compaction did not produce a safe context. Review the compaction warning before continuing.";

interface AutoCompactionOutcome {
	compacted: boolean;
	shouldContinue: boolean;
	/** Compaction persisted, but the rebuilt context is still unsafe to send. */
	mustStop?: boolean;
	/** An extension declined this compaction via session_before_compact. */
	cancelled?: boolean;
}

export interface MidTurnCompactionOutcome {
	messages?: AgentMessage[];
	stopErrorMessage?: string;
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

interface SummarizationRequestAuth {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/**
 * The slice of AgentSession that auto-compaction needs. Every member forwards
 * to existing session state; the host does not grant new capabilities.
 */
export interface CompactionHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	getModel(): Model<any> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getExtensionRunner(): ExtensionRunner;
	/** Whether a manual /compact run currently owns the compaction lifecycle. */
	isManualCompactionActive(): boolean;
	emit(event: AgentSessionEvent): void;
	emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void>;
	getRequiredRequestAuth(model: Model<any>): Promise<SummarizationRequestAuth>;
	getSummarizationRequestAuth(
		model: Model<any>,
		streamFunction: Agent["streamFunction"],
	): Promise<SummarizationRequestAuth>;
	summarizationRetryCallbacks(source: {
		source: "compaction";
		reason: "manual" | "threshold" | "overflow";
	}): RetryCallbacks;
}

/**
 * Owns automatic compaction: threshold checks after tool batches (mid-turn),
 * after a run, and before a prompt; overflow compact-and-retry recovery; and
 * the fail-closed stop when compaction cannot produce a safe context.
 * Manual /compact stays in AgentSession.
 */
export class CompactionController {
	private readonly host: CompactionHost;
	private _abortController: AbortController | undefined = undefined;
	private _stopAfterTurnRequested = false;
	/** An extension cancelled a mid-turn compaction; skip further mid-turn checks this run. */
	private _midTurnDeclined = false;
	private _overflowRecoveryAttempted = false;

	constructor(host: CompactionHost) {
		this.host = host;
	}

	/** Clear per-run state when a new agent run starts. */
	noteRunStart(): void {
		this._stopAfterTurnRequested = false;
		this._midTurnDeclined = false;
	}

	/** Read and clear the pending stop request. */
	consumeStopAfterTurn(): boolean {
		const requested = this._stopAfterTurnRequested;
		this._stopAfterTurnRequested = false;
		return requested;
	}

	/** Stop the run at the next lifecycle boundary instead of sending an unsafe context. */
	requestStopAfterTurn(): void {
		this._stopAfterTurnRequested = true;
	}

	/** A user message or a healthy assistant response resets overflow recovery. */
	resetOverflowRecovery(): void {
		this._overflowRecoveryAttempted = false;
	}

	get isAutoCompacting(): boolean {
		return this._abortController !== undefined;
	}

	abort(): void {
		this._abortController?.abort();
	}

	estimateContextTokens(messages: AgentMessage[]): number {
		const estimate = estimateContextTokens(messages);
		const compactionEntry = getLatestCompactionEntry(this.host.sessionManager.getBranch());
		if (compactionEntry && estimate.lastUsageIndex !== null) {
			const usageMessage = messages[estimate.lastUsageIndex];
			if (
				usageMessage?.role === "assistant" &&
				usageMessage.timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				// A retained pre-compaction usage describes the old, larger context. Fall back
				// to message estimates rather than immediately compacting again from stale data.
				return estimateMessagesTokens(messages);
			}
		}
		return estimate.tokens;
	}

	async maybeCompactBeforeNextToolTurn(
		turn: PrepareNextTurnContext,
		signal?: AbortSignal,
	): Promise<MidTurnCompactionOutcome> {
		if (signal?.aborted) {
			return { stopErrorMessage: AUTO_COMPACTION_STOPPED_BEFORE_NEXT_PROVIDER };
		}
		// Tool batches always continue the run; a turn without tool results only
		// continues when steering/follow-up messages are queued, otherwise the
		// post-run path covers it.
		if (turn.toolResults.length === 0 && !this.host.agent.hasQueuedMessages()) {
			return {};
		}
		if (this._midTurnDeclined) {
			return {};
		}

		const settings = this.host.settingsManager.getCompactionSettings();
		if (!settings.enabled) {
			return {};
		}

		const contextTokens = this.estimateContextTokens(turn.context.messages);
		const contextWindow = this.host.getModel()?.contextWindow ?? 0;
		if (!shouldCompact(contextTokens, contextWindow, settings)) {
			return {};
		}

		const outcome = await this._runAutoCompactionWithOutcome("threshold", false, "midTurn", signal);
		if (!outcome.compacted) {
			if (outcome.cancelled && signal?.aborted !== true) {
				// The extension took ownership of the risk; don't re-ask on every batch.
				this._midTurnDeclined = true;
				return {};
			}
			return { stopErrorMessage: AUTO_COMPACTION_STOPPED_BEFORE_NEXT_PROVIDER };
		}

		return {
			messages: this.host.agent.state.messages.slice(),
			...(signal?.aborted === true
				? { stopErrorMessage: AUTO_COMPACTION_STOPPED_BEFORE_NEXT_PROVIDER }
				: outcome.mustStop === true
					? { stopErrorMessage: CONTEXT_REMAINS_OVER_COMPACTION_THRESHOLD }
					: {}),
		};
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Recoverable failure: LLM returned context overflow or stopped below its desired output limit;
	 *    remove the assistant message, compact, and auto-retry once
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	async checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		timing: CompactionTiming = "postRun",
	): Promise<boolean> {
		const settings = this.host.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const model = this.host.getModel();
		const contextWindow = model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel = model && assistantMessage.provider === model.provider && assistantMessage.model === model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.host.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Recoverable failure. Explicit/silent context overflow still uses context metadata.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		// A successful response over the configured window should compact but must not retry: the
		// assistant answer already completed and agent.continue() cannot continue from an assistant.
		const contextOverflow = sameModel && isContextOverflow(assistantMessage, contextWindow);
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false, timing);
			}

			if (this._overflowRecoveryAttempted) {
				this._stopAfterTurnRequested = true;
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this.host.emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this.host.emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the failed or truncated message from agent state. It remains in session history,
			// but must not be included in the compact-and-retry context.
			const messages = this.host.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.host.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry, timing);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.host.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false, timing);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		timing: CompactionTiming = "postRun",
	): Promise<boolean> {
		const outcome = await this._runAutoCompactionWithOutcome(reason, willRetry, timing);
		if (!outcome.compacted || outcome.mustStop) {
			this._stopAfterTurnRequested = true;
		}
		return outcome.shouldContinue;
	}

	private async _runAutoCompactionWithOutcome(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		timing: CompactionTiming,
		parentSignal?: AbortSignal,
	): Promise<AutoCompactionOutcome> {
		const settings = this.host.settingsManager.getCompactionSettings();
		let started = false;
		let fromExtension = false;
		let controller: AbortController | undefined;
		let removeParentAbortListener: (() => void) | undefined;

		try {
			const model = this.host.getModel();
			if (!model || this._abortController || this.host.isManualCompactionActive() || parentSignal?.aborted) {
				return { compacted: false, shouldContinue: false };
			}
			const streamFunction = this.host.agent.streamFunction;
			const thinkingLevel = this.host.getThinkingLevel();
			const retrySettings = this.host.settingsManager.getRetrySettings();

			controller = new AbortController();
			if (parentSignal) {
				const abortFromParent = () => controller?.abort();
				parentSignal.addEventListener("abort", abortFromParent, { once: true });
				removeParentAbortListener = () => parentSignal.removeEventListener("abort", abortFromParent);
			}
			if (controller.signal.aborted) {
				return { compacted: false, shouldContinue: false };
			}
			this._abortController = controller;
			started = true;
			this.host.emit({ type: "compaction_start", reason });
			if (controller.signal.aborted) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				await this.host.emitSessionCompactFailed({
					reason,
					aborted: true,
					willRetry: false,
					fromExtension: false,
				});
				return { compacted: false, shouldContinue: false };
			}

			let extensionCompaction: CompactionResult | undefined;
			const pathEntries = this.host.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				throw new Error(NOTHING_TO_COMPACT_WITHIN_KEEP_WINDOW);
			}

			const extensionRunner = this.host.getExtensionRunner();
			if (extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					timing,
					willRetry,
					signal: controller.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this.host.emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this.host.emitSessionCompactFailed({
						reason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					// A cancel produced by an abort (abortCompaction/parent abort) is not an
					// extension decision; only a voluntary cancel hands the risk to the extension.
					return { compacted: false, shouldContinue: false, cancelled: !controller.signal.aborted };
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				let requestModel = model;
				let apiKey: string | undefined;
				let headers: Record<string, string> | undefined;
				let env: Record<string, string> | undefined;
				if (streamFunction === streamSimple) {
					({ model: requestModel, apiKey, headers, env } = await this.host.getRequiredRequestAuth(model));
				} else {
					({
						model: requestModel,
						apiKey,
						headers,
						env,
					} = await this.host.getSummarizationRequestAuth(model, streamFunction));
				}
				if (controller.signal.aborted) {
					this.host.emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this.host.emitSessionCompactFailed({
						reason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					return { compacted: false, shouldContinue: false };
				}

				// Generate compaction result
				const compactResult = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					controller.signal,
					thinkingLevel,
					streamFunction,
					env,
					retrySettings,
					this.host.summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			if (controller.signal.aborted) {
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				await this.host.emitSessionCompactFailed({
					reason,
					aborted: true,
					willRetry: false,
					fromExtension,
				});
				return { compacted: false, shouldContinue: false };
			}

			this.host.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				usage,
			);
			const newEntries = this.host.sessionManager.getEntries();
			const sessionContext = this.host.sessionManager.buildSessionContext();
			this.host.agent.state.messages = sessionContext.messages;
			if (willRetry) {
				const messages = this.host.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (
					lastMsg?.role === "assistant" &&
					((lastMsg as AssistantMessage).stopReason === "error" ||
						(lastMsg as AssistantMessage).stopReason === "length")
				) {
					this.host.agent.state.messages = messages.slice(0, -1);
				}
			}
			const estimatedTokensAfter = this.estimateContextTokens(this.host.agent.state.messages);
			const contextStillOverThreshold = shouldCompact(estimatedTokensAfter, model.contextWindow, settings);
			const effectiveWillRetry = willRetry && !contextStillOverThreshold;

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (savedCompactionEntry) {
				await extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry: effectiveWillRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this.host.emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry: effectiveWillRetry,
				...(contextStillOverThreshold ? { errorMessage: CONTEXT_REMAINS_OVER_COMPACTION_THRESHOLD } : {}),
			});
			if (contextStillOverThreshold) {
				return { compacted: true, shouldContinue: false, mustStop: true };
			}

			if (effectiveWillRetry) {
				return { compacted: true, shouldContinue: true };
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return { compacted: true, shouldContinue: this.host.agent.hasQueuedMessages() };
		} catch (error) {
			const aborted = controller?.signal.aborted || (error instanceof Error && error.name === "AbortError");
			const message = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this.host.emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					...(errorMessage ? { errorMessage } : {}),
				});
				await this.host.emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return { compacted: false, shouldContinue: false };
		} finally {
			removeParentAbortListener?.();
			if (this._abortController === controller) {
				this._abortController = undefined;
			}
		}
	}
}
