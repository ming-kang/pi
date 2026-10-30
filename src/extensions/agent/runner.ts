import { unlink } from "node:fs/promises";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { TaskCompletion, TaskControl, TaskTerminalStatus } from "../../core/tasks/types.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { writeOutputFile } from "../../utils/output-files.ts";
import {
	activitiesText,
	activityTarget,
	boundedAgentText,
	clipText,
	compactArguments,
	finalAssistantText,
} from "./activity.ts";
import {
	AGENT_MAX_ACTIVITIES,
	AGENT_REPORT_BYTES,
	type AgentActivity,
	type AgentToolDetails,
	emptyUsage,
} from "./types.ts";

const AGENT_TOOLS = ["read", "bash", "edit", "write"];

/** One small session-local queue; Tasks owns the visible queued/running state. */
export class AgentGate {
	private active = 0;
	private readonly limit: number;
	private readonly waiting: Array<{
		signal: AbortSignal;
		abort(): void;
		enter(): void;
	}> = [];

	constructor(limit = 4) {
		this.limit = limit;
	}

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Agent cancelled while queued."));
		return new Promise((resolve, reject) => {
			let settled = false;
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				this.active--;
				this.next();
			};
			const waiter = {
				signal,
				abort: () => {
					if (settled) return;
					settled = true;
					const index = this.waiting.indexOf(waiter);
					if (index >= 0) this.waiting.splice(index, 1);
					signal.removeEventListener("abort", waiter.abort);
					reject(signal.reason ?? new Error("Agent cancelled while queued."));
				},
				enter: () => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", waiter.abort);
					this.active++;
					resolve(release);
				},
			};
			signal.addEventListener("abort", waiter.abort, { once: true });
			if (this.active < this.limit) waiter.enter();
			else this.waiting.push(waiter);
		});
	}

	private next(): void {
		const waiter = this.waiting.shift();
		if (!waiter) return;
		if (waiter.signal.aborted) {
			waiter.abort();
			this.next();
		} else waiter.enter();
	}
}

export interface AgentRequest {
	prompt: string;
	cwd: string;
	model: Model<any>;
	thinking: ThinkingLevel;
	modelRuntime: ModelRuntime;
	projectTrusted: boolean;
}

function workerPrompt(base: string | undefined): string {
	return [
		base,
		"You are an Agent working independently on one delegated task.",
		"You cannot see the parent conversation. Treat the parent Agent as your caller, rely on the task briefing and available workspace context, and do not ask the end user questions. If anything is unclear, explain the ambiguity in your final report.",
		"Work in the assigned directory and stay within the requested scope. Use read for known-path file reads and bash for file discovery, search, and shell commands.",
		"Do not delegate or start background work. Run required commands in the foreground and wait for them.",
		"Only your final report returns to the caller. Make it self-contained: include essential findings or changes, verification when applicable, blockers, and unresolved risks; omit process narration.",
	]
		.filter((part): part is string => Boolean(part?.trim()))
		.join("\n\n");
}

function errorText(error: unknown): string {
	return clipText(error instanceof Error ? error.message : String(error), 4096);
}

async function removeOutputFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function finalText(
	control: TaskControl<AgentToolDetails>,
	report: string,
	error: string | undefined,
): Promise<string> {
	const text = !report ? (error ?? "No report returned.") : error ? `${report}\n\nError: ${error}` : report;
	if (Buffer.byteLength(text) <= AGENT_REPORT_BYTES) return text;
	let path: string | undefined;
	try {
		path = await writeOutputFile("pi-agent", ".md", text);
		control.setOutputPath(path, () => removeOutputFile(path!));
		return boundedAgentText(text, AGENT_REPORT_BYTES, path);
	} catch {
		if (path) await removeOutputFile(path).catch(() => {});
		return boundedAgentText(text);
	}
}

async function prepareWorkerSession(request: AgentRequest, signal: AbortSignal): Promise<CreateAgentSessionOptions> {
	signal.throwIfAborted();
	const agentDir = getAgentDir();
	const source = SettingsManager.create(request.cwd, agentDir, { projectTrusted: request.projectTrusted });
	const loader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir,
		settingsManager: source,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPromptOverride: workerPrompt,
	});
	await loader.reload();
	signal.throwIfAborted();
	// Resource discovery can reload its source; execution owns a detached snapshot, never that source.
	const settingsManager = SettingsManager.inMemory(
		{ ...source.getGlobalSettings(), cacheWarming: "off" },
		{ projectTrusted: request.projectTrusted },
	);
	settingsManager.applyOverrides(source.getProjectSettings());
	return {
		cwd: request.cwd,
		agentDir,
		modelRuntime: request.modelRuntime,
		model: request.model,
		thinkingLevel: request.thinking,
		backgroundAllowed: false,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(request.cwd),
		tools: AGENT_TOOLS,
	};
}

export async function runAgent(
	control: TaskControl<AgentToolDetails>,
	request: AgentRequest,
	gate: AgentGate,
): Promise<TaskCompletion<AgentToolDetails>> {
	const { signal } = control;
	const release = await gate.acquire(signal);
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let usage: Usage = emptyUsage();
	let lastMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
	const seen = new WeakSet<AgentMessage>();
	const activities: AgentActivity[] = [];
	const modelName = `${request.model.provider}/${request.model.id}`;
	const details = (status: AgentToolDetails["status"], error?: string): AgentToolDetails => ({
		version: 1,
		taskId: control.id,
		status,
		model: modelName,
		thinking: request.thinking,
		...(error ? { error } : {}),
		activities: structuredClone(activities),
	});
	const publish = () => {
		control.publish({
			content: [{ type: "text", text: activities.length ? activitiesText(activities) : "Starting Agent…" }],
			details: details("running"),
			usage,
		});
	};
	const abort = () => {
		void session?.abort().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const options = await raceWithAbortSignal(prepareWorkerSession(request, signal), signal);
		signal.throwIfAborted();
		// Adopt an actual session before checking cancellation; never race away its cleanup handle.
		const created = await createAgentSession(options);
		session = created.session;
		signal.throwIfAborted();
		unsubscribe = session.subscribe((event) => {
			// Cancellation during prompt preflight can precede the run's own abort controller.
			if (event.type === "agent_start" && signal.aborted) {
				abort();
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				lastMessage = event.message;
				if (!seen.has(event.message)) {
					seen.add(event.message);
					usage = combineUsage(usage, event.message.usage);
				}
				return;
			}
			if (event.type === "compaction_end" && event.result?.usage) {
				usage = combineUsage(usage, event.result.usage);
				return;
			}
			if (event.type === "tool_execution_start") {
				activities.push({
					id: event.toolCallId,
					name: event.toolName,
					args: compactArguments(event.args),
					target: activityTarget(event.toolName, event.args),
					status: "running",
				});
				if (activities.length > AGENT_MAX_ACTIVITIES) activities.shift();
			} else if (event.type === "tool_execution_end") {
				const activity = activities.findLast((item) => item.id === event.toolCallId);
				if (!activity) return;
				activity.status = signal.aborted ? "cancelled" : event.isError ? "error" : "ok";
				activity.durationMs = event.durationMs;
				if (event.isError) {
					const result = event.result as { content?: Array<{ type: string; text?: string }> };
					activity.error = clipText(
						result.content
							?.filter((block) => block.type === "text")
							.map((block) => block.text ?? "")
							.join("\n") || "Tool call failed.",
						1000,
					);
				}
			} else return;
			publish();
		});
		publish();
		control.accept();
		signal.throwIfAborted();
		await session.prompt(request.prompt, { expandPromptTemplates: false });
		const report = finalAssistantText(session.messages);
		const status: TaskTerminalStatus =
			signal.aborted || lastMessage?.stopReason === "aborted"
				? "cancelled"
				: !lastMessage || lastMessage.stopReason === "error" || lastMessage.stopReason === "length"
					? "failed"
					: "completed";
		const error =
			status === "cancelled"
				? "Agent cancelled."
				: status === "failed"
					? errorText(lastMessage?.errorMessage || "Agent ended without a complete report.")
					: undefined;
		return {
			status,
			error,
			usage,
			result: {
				content: [{ type: "text", text: await finalText(control, report, error) }],
				details: details(status, error),
				...(status === "completed" ? {} : { isError: true }),
			},
		};
	} catch (error) {
		const status: TaskTerminalStatus = signal.aborted ? "cancelled" : "failed";
		const reason = status === "cancelled" ? "Agent cancelled." : errorText(error);
		const report = session ? finalAssistantText(session.messages) : "";
		return {
			status,
			error: reason,
			usage,
			result: {
				content: [{ type: "text", text: await finalText(control, report, reason) }],
				details: details(status, reason),
				isError: true,
			},
		};
	} finally {
		signal.removeEventListener("abort", abort);
		unsubscribe?.();
		session?.dispose();
		release();
	}
}
