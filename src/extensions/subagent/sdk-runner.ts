import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	activitySummary,
	addUsage,
	appendActivity,
	assistantText,
	boundText,
	finalAssistantText,
	resultSummary,
	setLiveText,
} from "./activity.ts";
import { ERROR_TEXT_LIMIT, LIVE_TEXT_LIMIT, SINGLE_OUTPUT_LIMIT } from "./constants.ts";
import { beginSubagentRetry, clearSubagentRetry } from "./retry.ts";
import type { ResolvedSubagentTask, SubagentRunDetails, ToolActivity } from "./types.ts";

export interface SdkRunnerOptions {
	task: ResolvedSubagentTask;
	run: SubagentRunDetails;
	modelRuntime: ModelRuntime;
	agentDir: string;
	projectTrusted: boolean;
	signal?: AbortSignal;
	onProgress?: () => void;
	registerAbort?: (abort: () => Promise<void>) => () => void;
}

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
		"When referencing files in the final report, use absolute paths so the caller can locate them unambiguously.",
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

type AutoRetryEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>;

export function applySubagentAutoRetryEvent(run: SubagentRunDetails, event: AutoRetryEvent): void {
	if (event.type === "auto_retry_start") {
		beginSubagentRetry(run, {
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			error: event.errorMessage,
		});
		return;
	}
	clearSubagentRetry(run);
}

export async function runSdkTask(options: SdkRunnerOptions): Promise<SubagentRunDetails> {
	const { task, run, modelRuntime, agentDir, projectTrusted, signal, onProgress } = options;
	const throttled = createThrottledEmitter(onProgress);
	let unsubscribe: (() => void) | undefined;
	let unregisterAbort: (() => void) | undefined;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const activeActivities = new Map<string, ToolActivity>();
	const seenAssistantMessages = new Set<unknown>();
	const markAbort = async (): Promise<void> => {
		clearSubagentRetry(run);
		run.status = "aborted";
		run.error ??= "Subagent was aborted.";
		if (session) await session.abort();
	};
	const isAborted = (): boolean => signal?.aborted === true || run.status === "aborted";
	const abortListener = () => {
		void markAbort().catch(() => undefined);
	};
	unregisterAbort = options.registerAbort?.(markAbort);
	if (signal) signal.addEventListener("abort", abortListener, { once: true });

	try {
		if (isAborted()) {
			clearSubagentRetry(run);
			run.status = "aborted";
			run.error = "Subagent was aborted before it started.";
			return run;
		}

		clearSubagentRetry(run);
		run.status = "running";
		run.startedAt = Date.now();
		onProgress?.();
		const settingsManager = SettingsManager.create(task.cwd, agentDir, { projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd: task.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			// Read-only explorers skip AGENTS.md/CLAUDE.md: they don't need
			// commit/PR/style rules, and the parent interprets their results.
			noContextFiles: task.agent.omitContextFiles ?? false,
			systemPromptOverride: (base) => workerSystemPrompt(base, task),
		});
		await resourceLoader.reload();
		if (isAborted()) {
			run.error ??= "Subagent was aborted during initialization.";
			return run;
		}
		const createPromise = createAgentSession({
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
		// createAgentSession takes no signal and can hang on network work, so
		// abort races it; a session that resolves after the race is lost is
		// disposed instead of leaking.
		let abortRace: Promise<never> | undefined;
		if (signal) {
			abortRace = new Promise<never>((_resolve, reject) => {
				const rejectOnAbort = () => {
					void createPromise.then(
						(createdLate) => createdLate.session.dispose(),
						() => {},
					);
					reject(new Error("Subagent session creation was aborted."));
				};
				if (signal.aborted) {
					rejectOnAbort();
					return;
				}
				const abortListener = () => rejectOnAbort();
				signal.addEventListener("abort", abortListener, { once: true });
				void createPromise.then(
					() => signal.removeEventListener("abort", abortListener),
					() => signal.removeEventListener("abort", abortListener),
				);
			});
		}
		const created = await (abortRace ? Promise.race([createPromise, abortRace]) : createPromise);
		session = created.session;
		if (isAborted()) {
			run.error ??= "Subagent was aborted during initialization.";
			await session.abort();
			return run;
		}
		const emitImmediate = () => onProgress?.();
		const emitText = throttled.emit;
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
				applySubagentAutoRetryEvent(run, event);
				emitImmediate();
				return;
			}
			if (event.type === "turn_end") {
				clearSubagentRetry(run);
				run.usage.turns++;
				run.currentActivity = undefined;
				emitImmediate();
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				clearSubagentRetry(run);
				if (!seenAssistantMessages.has(event.message)) {
					seenAssistantMessages.add(event.message);
					addUsage(run.usage, event.message.usage);
				}
				run.liveText = setLiveText(assistantText(event.message));
				emitText();
				return;
			}
			if (event.type === "message_update") {
				clearSubagentRetry(run);
				if (event.message.role === "assistant") run.liveText = setLiveText(assistantText(event.message));
				if (event.assistantMessageEvent.type === "thinking_delta") run.currentActivity = "Thinking…";
				if (event.assistantMessageEvent.type === "text_delta") run.currentActivity = "Writing response…";
				emitText();
				return;
			}
			if (event.type === "tool_execution_start") {
				clearSubagentRetry(run);
				run.usage.toolUses++;
				const activity: ToolActivity = {
					id: event.toolCallId,
					toolName: event.toolName,
					summary: activitySummary(event.toolName, event.args),
					status: "running",
					startedAt: Date.now(),
				};
				activeActivities.set(event.toolCallId, activity);
				appendActivity(run.activities, activity);
				run.currentActivity = activity.summary;
				emitImmediate();
				return;
			}
			if (event.type === "tool_execution_update") {
				clearSubagentRetry(run);
				run.currentActivity = activitySummary(event.toolName, event.args);
				emitText();
				return;
			}
			if (event.type === "tool_execution_end") {
				clearSubagentRetry(run);
				const activity = activeActivities.get(event.toolCallId);
				if (activity) {
					activity.status = event.isError ? "failed" : "succeeded";
					activity.endedAt = Date.now();
					activity.resultSummary = resultSummary(event.result);
				}
				activeActivities.delete(event.toolCallId);
				run.currentActivity = undefined;
				emitImmediate();
			}
		});
		await session.prompt(task.prompt);
		const finalMessage = lastAssistantMessage(session);
		run.finalOutput = finalAssistantText(session.messages);
		const error = assistantError(finalMessage);
		if (signal?.aborted || finalMessage?.stopReason === "aborted") {
			run.status = "aborted";
			run.error = boundText(error ?? "Subagent was aborted.", ERROR_TEXT_LIMIT);
		} else if (finalMessage?.stopReason === "error" || error) {
			run.status = "failed";
			run.error = boundText(error ?? "Subagent failed.", ERROR_TEXT_LIMIT);
		} else {
			run.status = "completed";
		}
	} catch (error) {
		if (signal?.aborted || run.status === "aborted") {
			run.status = "aborted";
			run.error = run.error ?? "Subagent was aborted.";
		} else {
			run.status = "failed";
			run.error = boundText(error instanceof Error ? error.message : String(error), ERROR_TEXT_LIMIT);
		}
		if (session) run.finalOutput = finalAssistantText(session.messages);
	} finally {
		if (signal) signal.removeEventListener("abort", abortListener);
		throttled.cancel();
		unregisterAbort?.();
		unsubscribe?.();
		session?.dispose();
		run.liveText = boundText(run.liveText, LIVE_TEXT_LIMIT);
		run.finalOutput = boundText(run.finalOutput, SINGLE_OUTPUT_LIMIT);
		if (run.error) run.error = boundText(run.error, ERROR_TEXT_LIMIT);
		clearSubagentRetry(run);
		run.endedAt = Date.now();
		onProgress?.();
	}
	return run;
}
