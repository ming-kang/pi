import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { taskActivitiesText } from "../../core/tasks/activity.ts";
import { TASK_FACT_BYTES } from "../../core/tasks/output.ts";
import type { TaskCompletion, TaskControl, TaskDisplay, TaskFact, TaskTerminalStatus } from "../../core/tasks/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { emptyUsage } from "../../utils/usage.ts";
import { activityTarget, clipText, compactArguments, relativeToCwd } from "./activity.ts";
import { type AgentArtifacts, fitList, savedTranscript } from "./artifacts.ts";
import type { FinalReport } from "./report.ts";
import { AGENT_MAX_ACTIVITIES, type AgentActivity, type AgentToolDetails } from "./types.ts";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function finalAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]!);
		if (text.trim()) return text;
	}
	return "";
}

function toolErrorText(result: unknown): string {
	const content =
		result && typeof result === "object" && "content" in result && Array.isArray(result.content)
			? result.content
			: undefined;
	const text = content
		?.filter(
			(block): block is { type: string; text?: string } =>
				Boolean(block) && typeof block === "object" && "type" in block && block.type === "text",
		)
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");
	return clipText(text || "Tool call failed.", 1000);
}

/** Tools whose successful calls change the named file. */
const EDIT_TOOLS = new Set(["edit", "write"]);
/** The model-facing Edited line stays this small, whatever the Agent changed. */
const EDITED_LINE_BYTES = 1024;
const EDITED_LINE_PREFIX = "Edited (edit/write): ";

/**
 * One worker session translated into task progress: a one-line status for the model,
 * tool activity for humans, and cumulative usage for the ledger.
 */
export class AgentProgress {
	private readonly control: TaskControl<AgentToolDetails>;
	private readonly activities: AgentActivity[] = [];
	private readonly counted = new WeakSet<AgentMessage>();
	private calls = 0;
	private failedCalls = 0;
	/** The file key of each in-flight edit/write call, by tool call id. */
	private readonly pendingEdits = new Map<string, string>();
	/**
	 * Files named by edit/write calls in the order their first call started, so parallel calls give a
	 * stable order; only files with a successful call count as edited. Never trimmed with the activity list.
	 */
	private readonly attempts = new Map<string, { display: string; changed: boolean }>();
	private usage: Usage = emptyUsage();
	private last?: AssistantMessage;
	/** What the model-facing status line names; it keeps the path as the Agent wrote it. */
	private latest = "";
	/** The Agent's working directory, used to show paths inside it relative. */
	private readonly cwd?: string;

	constructor(control: TaskControl<AgentToolDetails>, cwd?: string) {
		this.control = control;
		this.cwd = cwd;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.last = event.message;
				if (!this.counted.has(event.message)) {
					this.counted.add(event.message);
					this.usage = combineUsage(this.usage, event.message.usage);
				}
				return;
			case "compaction_end":
				if (event.result?.usage) this.usage = combineUsage(this.usage, event.result.usage);
				return;
			case "tool_execution_start":
				this.calls++;
				if (EDIT_TOOLS.has(event.toolName)) this.trackEditStart(event.toolCallId, event.args);
				this.latest = [event.toolName, activityTarget(event.toolName, event.args)].filter(Boolean).join(" ");
				this.activities.push({
					id: event.toolCallId,
					name: event.toolName,
					args: compactArguments(event.args),
					target: activityTarget(event.toolName, event.args, this.cwd),
					status: "running",
					startedAt: Date.now(),
				});
				if (this.activities.length > AGENT_MAX_ACTIVITIES) this.activities.shift();
				break;
			case "tool_execution_end": {
				const key = this.pendingEdits.get(event.toolCallId);
				this.pendingEdits.delete(event.toolCallId);
				const attempt = key === undefined ? undefined : this.attempts.get(key);
				if (attempt && !event.isError) attempt.changed = true;
				if (event.isError && !this.control.signal.aborted) this.failedCalls++;
				const activity = this.activities.findLast((item) => item.id === event.toolCallId);
				if (!activity) return;
				activity.status = this.control.signal.aborted ? "cancelled" : event.isError ? "error" : "ok";
				activity.durationMs = event.durationMs;
				if (event.isError) activity.error = toolErrorText(event.result);
				break;
			}
			default:
				return;
		}
		this.publish();
	}

	publish(): void {
		this.control.publish({
			result: {
				content: [{ type: "text", text: this.status() }],
				details: {
					version: 2,
					state: "running",
					taskId: this.control.id,
					activities: structuredClone(this.activities),
				},
			},
			display: this.display(),
			usage: this.usage,
		});
	}

	/** Classify a finished run from its last assistant message. */
	outcome(): { status: TaskTerminalStatus; error?: string } {
		const last = this.last;
		if (this.control.signal.aborted || last?.stopReason === "aborted")
			return { status: "cancelled", error: "Agent cancelled." };
		if (!last || last.stopReason === "error" || last.stopReason === "length")
			return {
				status: "failed",
				error: clipText(last?.errorMessage || "Agent ended without a complete report.", 4096),
			};
		return { status: "completed" };
	}

	/** The settled Agent's Details rows: call counts, files changed, and where the full report and transcript live. */
	facts(report: FinalReport, artifacts?: AgentArtifacts): TaskFact[] {
		const calls = `${this.calls}${this.failedCalls ? ` · ${this.failedCalls} failed` : ""}`;
		const facts: TaskFact[] = [["Tool calls", calls]];
		const edited = this.editedFiles();
		if (edited.length) facts.push(["Edited", fitList(edited, TASK_FACT_BYTES)]);
		if (report.reportPath) facts.push(["Report", report.reportPath]);
		const transcript = savedTranscript(artifacts);
		if (transcript) facts.push(["Transcript", transcript]);
		return facts;
	}

	/** Settle with the bounded report, then the Edited line, so truncation can never cut it. */
	complete(
		status: TaskTerminalStatus,
		error: string | undefined,
		report: FinalReport,
		artifacts?: AgentArtifacts,
	): TaskCompletion<AgentToolDetails> {
		const edited = this.editedFiles();
		const line = edited.length
			? `\n\n${EDITED_LINE_PREFIX}${fitList(edited, EDITED_LINE_BYTES - EDITED_LINE_PREFIX.length)}`
			: "";
		return {
			status,
			error,
			usage: this.usage,
			facts: this.facts(report, artifacts),
			result: {
				content: [{ type: "text", text: report.text + line }],
				details: { version: 2, state: status, taskId: this.control.id, ...(error ? { error } : {}) },
				...(status === "completed" ? {} : { isError: true }),
			},
		};
	}

	/** Display paths of the files a successful edit/write call changed, each once. */
	private editedFiles(): string[] {
		return [...this.attempts.values()].filter((attempt) => attempt.changed).map((attempt) => attempt.display);
	}

	private trackEditStart(id: string, args: unknown): void {
		const path = (args as { path?: unknown } | null)?.path;
		if (typeof path !== "string" || !path.trim()) return;
		const resolved = this.cwd ? resolveToCwd(path, this.cwd) : path;
		// One key per file, however the Agent spelled its path.
		const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
		if (!this.attempts.has(key))
			this.attempts.set(key, { display: relativeToCwd(resolved, this.cwd), changed: false });
		this.pendingEdits.set(id, key);
	}

	/** Model-readable progress: the report is the contract, so intermediate text never leaves the worker. */
	private status(): string {
		if (!this.latest) return "Agent running; no tool calls yet.";
		const calls = `${this.calls} tool ${this.calls === 1 ? "call" : "calls"}`;
		return `Agent running · ${calls} · latest: ${this.latest}`;
	}

	/**
	 * Human-only live Output: the compact tool-call list, never sent to the model. A settled Agent
	 * publishes no display, so /tasks then shows its report.
	 */
	private display(): TaskDisplay {
		const earlierActivities = this.calls - this.activities.length;
		return {
			text: taskActivitiesText(this.activities, earlierActivities),
			truncated: false,
			activities: this.activities,
			earlierActivities,
		};
	}
}
