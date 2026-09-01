import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { finalAssistantText } from "./activity.ts";
import type { RunCancellation } from "./cancellation.ts";
import type { SubagentRunEvent } from "./state.ts";
import type { ResolvedSubagentTask } from "./types.ts";

export interface SdkRunnerOptions {
	task: ResolvedSubagentTask;
	/** Cancellation scope covering this attempt (queued through session end). */
	scope: RunCancellation;
	/** Reducer input; the adapter never touches run state directly. */
	dispatch: (event: SubagentRunEvent) => void;
	modelRuntime: ModelRuntime;
	agentDir: string;
	projectTrusted: boolean;
	onProgress?: () => void;
}

/**
 * Assembles the worker session's system prompt.
 * @param base - The global system prompt from resource loading; undefined when
 *   no global system prompt is configured (e.g. no AGENTS.md or system prompt override).
 */
function workerSystemPrompt(base: string | undefined, task: ResolvedSubagentTask): string {
	return [
		base,
		`You are Pi subagent "${task.agent.name}", working independently on one delegated task.`,
		"You cannot see the parent conversation; rely entirely on the task briefing and repository context available in your working directory.",
		"Only your final message is returned to the caller; nothing you write in earlier turns is visible to anyone.",
		"Complete the task fully—do not gold-plate it, but do not leave it half-done.",
		"Stay inside the assigned working directory and delegated scope.",
		"Do not ask the end user questions. If blocked, report the exact blocker and what would resolve it.",
		"Do not spawn subagents or invoke tools outside the configured tool list.",
		"When referencing files in the final report, use paths relative to the task's working directory so the caller can locate them unambiguously.",
		"Include code snippets only when the exact text is load-bearing (a bug you found, a signature the caller asked for); do not recap code you merely read.",
		"End with a concise report covering findings or changes, verification performed, blockers, and unresolved risks. The caller will relay it to the user, so include only the essentials.",
		task.agent.systemPrompt,
	]
		.filter((part): part is string => Boolean(part?.trim()))
		.join("\n\n");
}

function lastAssistantMessage(session: { messages: readonly AgentMessage[] }) {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function assistantError(message: ReturnType<typeof lastAssistantMessage>): string | undefined {
	if (!message || message.role !== "assistant") return undefined;
	return message.errorMessage;
}

interface ThrottledEmitter {
	emit: () => void;
	/** Drops any pending timer so nothing fires after the run has settled. */
	cancel: () => void;
}

function createThrottledEmitter(onProgress: (() => void) | undefined): ThrottledEmitter {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		emit: () => {
			if (!onProgress || timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				onProgress();
			}, 80);
		},
		cancel: () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

export interface MappedSessionEvent {
	runEvent: SubagentRunEvent;
	/** Whether the progress emission should be immediate (true) or throttled (false). */
	immediate: boolean;
}

/**
 * Pure mapping from AgentSessionEvent to SubagentRunEvent. Returns undefined
 * for events the subagent adapter does not handle. Exported for unit testing.
 */
export function mapSessionEvent(
	event: AgentSessionEvent,
	seenAssistantMessages: Set<unknown>,
	now = Date.now(),
): MappedSessionEvent | undefined {
	if (event.type === "auto_retry_start") {
		return {
			runEvent: {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				deadline: now + event.delayMs,
				error: event.errorMessage,
			},
			immediate: true,
		};
	}
	if (event.type === "auto_retry_end") {
		return { runEvent: { type: "auto_retry_end" }, immediate: true };
	}
	if (event.type === "turn_end") {
		return { runEvent: { type: "turn_end" }, immediate: true };
	}
	if (event.type === "compaction_start") {
		return { runEvent: { type: "compaction_started", startedAt: now }, immediate: true };
	}
	if (event.type === "compaction_end") {
		return {
			runEvent: {
				type: "compaction_ended",
				tokensBefore: event.result?.tokensBefore,
				tokensAfter: event.result?.estimatedTokensAfter,
				error: event.errorMessage,
				endedAt: now,
			},
			immediate: true,
		};
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const usage = seenAssistantMessages.has(event.message) ? undefined : event.message.usage;
		seenAssistantMessages.add(event.message);
		return { runEvent: { type: "assistant_message_settled", usage }, immediate: true };
	}
	if (event.type === "tool_execution_start") {
		return {
			runEvent: {
				type: "tool_started",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				startedAt: now,
			},
			immediate: true,
		};
	}
	if (event.type === "tool_execution_update") {
		return {
			runEvent: {
				type: "tool_updated",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			},
			immediate: false,
		};
	}
	if (event.type === "tool_execution_end") {
		return {
			runEvent: {
				type: "tool_ended",
				toolCallId: event.toolCallId,
				result: event.result,
				isError: event.isError,
				endedAt: now,
			},
			immediate: true,
		};
	}
	return undefined;
}

type InitializationOutcome =
	| { kind: "created"; session: Awaited<ReturnType<typeof createAgentSession>>["session"] }
	| { kind: "aborted" }
	| { kind: "error"; error: unknown };

// Neither resource loading nor session creation takes an abort signal, and
// both can hang on network work; race both against the scope. The losing
// chain keeps running, so its eventual result or rejection is always
// consumed by a no-op handler.
async function raceInitialization(
	chain: Promise<InitializationOutcome>,
	scope: RunCancellation,
): Promise<InitializationOutcome> {
	return new Promise<InitializationOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: InitializationOutcome): void => {
			if (settled) return;
			settled = true;
			scope.signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = (): void => {
			finish({ kind: "aborted" });
		};
		if (scope.signal.aborted) {
			onAbort();
			void chain.then(
				() => undefined,
				() => undefined,
			);
			return;
		}
		scope.signal.addEventListener("abort", onAbort, { once: true });
		void chain.then(
			(outcome) => finish(outcome),
			(error) => finish({ kind: "error", error }),
		);
	});
}

/**
 * Runs one worker attempt as a pure adapter: it owns the worker session's
 * lifecycle and translates AgentSessionEvents into SubagentRunEvents; every
 * state transition happens in the reducer on the other side of dispatch.
 */
export async function runSdkTask(options: SdkRunnerOptions): Promise<void> {
	const { task, scope, dispatch, modelRuntime, agentDir, projectTrusted, onProgress } = options;
	const throttled = createThrottledEmitter(onProgress);
	let unsubscribe: (() => void) | undefined;
	let unregisterAbort: (() => void) | undefined;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	// Streaming updates carry no semantic weight; the settled messages are
	// where usage is accounted, and worker sessions can replay them.
	const seenAssistantMessages = new Set<unknown>();
	const emitImmediate = (): void => onProgress?.();
	const emitThrottled = throttled.emit;

	unregisterAbort = scope.onAbort(async () => {
		if (session) await session.abort();
	});

	try {
		if (scope.aborted) {
			dispatch({
				type: "settle",
				verdict: "aborted",
				report: "",
				error: "Subagent was aborted before it started.",
				endedAt: Date.now(),
			});
			return;
		}

		const settingsManager = SettingsManager.create(task.cwd, agentDir, { projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd: task.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPromptOverride: (base) => workerSystemPrompt(base, task),
		});
		const initialization = (async (): Promise<InitializationOutcome> => {
			await resourceLoader.reload();
			if (scope.signal.aborted) return { kind: "aborted" };
			const created = await createAgentSession({
				cwd: task.cwd,
				agentDir,
				modelRuntime,
				model: task.model,
				thinkingLevel: task.thinking,
				tools: task.agent.tools,
				resourceLoader,
				sessionManager: SessionManager.inMemory(task.cwd),
				settingsManager,
			});
			return { kind: "created", session: created.session };
		})();
		const outcome = await raceInitialization(initialization, scope);
		if (outcome.kind === "error") throw outcome.error;
		if (outcome.kind === "aborted") {
			// The initialization chain cannot be cancelled. Dispose the
			// session if it eventually resolves, and swallow a late rejection
			// after this run has already settled.
			void initialization.then(
				(late) => {
					if (late.kind === "created") {
						try {
							late.session.dispose();
						} catch {
							// The aborted run has no remaining channel for cleanup errors.
						}
					}
				},
				() => {},
			);
			dispatch({
				type: "settle",
				verdict: "aborted",
				report: "",
				error: "Subagent was aborted during initialization.",
				endedAt: Date.now(),
			});
			return;
		}
		session = outcome.session;
		if (scope.aborted) {
			await session.abort();
			dispatch({
				type: "settle",
				verdict: "aborted",
				report: "",
				error: "Subagent was aborted during initialization.",
				endedAt: Date.now(),
			});
			return;
		}

		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const mapped = mapSessionEvent(event, seenAssistantMessages);
			if (!mapped) return;
			dispatch(mapped.runEvent);
			if (mapped.immediate) emitImmediate();
			else emitThrottled();
		});
		await session.prompt(task.prompt);
		const finalMessage = lastAssistantMessage(session);
		const report = finalAssistantText(session.messages);
		const error = assistantError(finalMessage);
		if (scope.signal.aborted || finalMessage?.stopReason === "aborted") {
			dispatch({
				type: "settle",
				verdict: "aborted",
				report,
				error: error ?? "Subagent was aborted.",
				endedAt: Date.now(),
			});
		} else if (finalMessage?.stopReason === "error" || error) {
			dispatch({
				type: "settle",
				verdict: "failed",
				report,
				error: error ?? "Subagent failed.",
				endedAt: Date.now(),
			});
		} else {
			dispatch({ type: "settle", verdict: "completed", report, error: undefined, endedAt: Date.now() });
		}
	} catch (error) {
		const report = session ? finalAssistantText(session.messages) : "";
		if (scope.signal.aborted) {
			dispatch({
				type: "settle",
				verdict: "aborted",
				report,
				error: "Subagent was aborted.",
				endedAt: Date.now(),
			});
		} else {
			dispatch({
				type: "settle",
				verdict: "failed",
				report,
				error: error instanceof Error ? error.message : String(error),
				endedAt: Date.now(),
			});
		}
	} finally {
		throttled.cancel();
		unregisterAbort?.();
		unsubscribe?.();
		session?.dispose();
		emitImmediate();
	}
}
