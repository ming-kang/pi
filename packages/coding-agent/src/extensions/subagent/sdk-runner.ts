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
import type { ResolvedSubagentTask, SubagentRunDetails, ToolActivity } from "./types.ts";

export interface SdkRunnerOptions {
	task: ResolvedSubagentTask;
	run: SubagentRunDetails;
	modelRuntime: ModelRuntime;
	agentDir: string;
	signal?: AbortSignal;
	onProgress?: () => void;
	registerAbort?: (abort: () => Promise<void>) => () => void;
}

function workerSystemPrompt(base: string | undefined, task: ResolvedSubagentTask): string {
	return [
		base,
		`You are Pi subagent "${task.agent.name}", working on one delegated task.`,
		"You cannot see the parent conversation; rely on the task briefing.",
		"Stay inside the assigned working directory and task scope.",
		"Do not ask the end user questions. If blocked, report the exact blocker.",
		"Do not spawn subagents or invoke tools outside the configured tool list.",
		"Return a concise report with findings or changes, exact paths, verification, and unresolved risks.",
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

function emitThrottled(onProgress: (() => void) | undefined): () => void {
	let pending = false;
	return () => {
		if (!onProgress || pending) return;
		pending = true;
		setTimeout(() => {
			pending = false;
			onProgress();
		}, 80);
	};
}

function cancelThrottled(onProgress: () => void): void {
	onProgress();
}

export async function runSdkTask(options: SdkRunnerOptions): Promise<SubagentRunDetails> {
	const { task, run, modelRuntime, agentDir, signal, onProgress } = options;
	const emitTextProgress = emitThrottled(onProgress);
	let unsubscribe: (() => void) | undefined;
	let unregisterAbort: (() => void) | undefined;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const activeActivities = new Map<string, ToolActivity>();
	const seenAssistantMessages = new Set<unknown>();
	const markAbort = async (): Promise<void> => {
		run.status = "aborted";
		if (session) await session.abort();
	};

	try {
		if (signal?.aborted) {
			run.status = "aborted";
			run.error = "Subagent was aborted before it started.";
			return run;
		}

		run.status = "running";
		run.startedAt = Date.now();
		onProgress?.();
		const settingsManager = SettingsManager.create(task.cwd, agentDir);
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
		await resourceLoader.reload();
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
		session = created.session;
		const emitImmediate = () => onProgress?.();
		const emitText = emitTextProgress;
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "turn_end") {
				run.usage.turns++;
				run.currentActivity = undefined;
				emitImmediate();
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				if (!seenAssistantMessages.has(event.message)) {
					seenAssistantMessages.add(event.message);
					addUsage(run.usage, event.message.usage);
				}
				run.liveText = setLiveText(assistantText(event.message));
				emitText();
				return;
			}
			if (event.type === "message_update") {
				if (event.message.role === "assistant") run.liveText = setLiveText(assistantText(event.message));
				if (event.assistantMessageEvent.type === "thinking_delta") run.currentActivity = "Thinking…";
				if (event.assistantMessageEvent.type === "text_delta") run.currentActivity = "Writing response…";
				emitText();
				return;
			}
			if (event.type === "tool_execution_start") {
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
				run.currentActivity = activitySummary(event.toolName, event.args);
				emitText();
				return;
			}
			if (event.type === "tool_execution_end") {
				const activity = activeActivities.get(event.toolCallId);
				if (activity) {
					activity.status = event.isError ? "failed" : "succeeded";
					activity.endedAt = Date.now();
					activity.resultSummary = resultSummary(event.result);
				}
				run.currentActivity = undefined;
				emitImmediate();
			}
		});
		const abortListener = () => {
			void markAbort().catch(() => undefined);
		};
		unregisterAbort = options.registerAbort?.(markAbort);
		if (signal) signal.addEventListener("abort", abortListener, { once: true });
		try {
			await session.prompt(task.prompt);
		} finally {
			if (signal) signal.removeEventListener("abort", abortListener);
		}
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
		cancelThrottled(emitTextProgress);
		unregisterAbort?.();
		unsubscribe?.();
		session?.dispose();
		run.liveText = boundText(run.liveText, LIVE_TEXT_LIMIT);
		run.finalOutput = boundText(run.finalOutput, SINGLE_OUTPUT_LIMIT);
		if (run.error) run.error = boundText(run.error, ERROR_TEXT_LIMIT);
		run.endedAt = Date.now();
		onProgress?.();
	}
	return run;
}
