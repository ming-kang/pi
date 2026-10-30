import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { TaskCompletion, TaskControl, TaskTerminalStatus } from "../../core/tasks/types.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { activitiesText, activityTarget, clipText, compactArguments } from "./activity.ts";
import { AGENT_MAX_ACTIVITIES, type AgentActivity, type AgentToolDetails } from "./types.ts";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

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
	const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
	const text = content
		?.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	return clipText(text || "Tool call failed.", 1000);
}

/**
 * One worker session translated into task progress: a one-line status for the model,
 * tool activity for humans, and cumulative usage for the ledger.
 */
export class AgentProgress {
	private readonly control: TaskControl<AgentToolDetails>;
	private readonly activities: AgentActivity[] = [];
	private readonly counted = new WeakSet<AgentMessage>();
	private calls = 0;
	private usage: Usage = emptyUsage();
	private last?: AssistantMessage;

	constructor(control: TaskControl<AgentToolDetails>) {
		this.control = control;
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
				this.activities.push({
					id: event.toolCallId,
					name: event.toolName,
					args: compactArguments(event.args),
					target: activityTarget(event.toolName, event.args),
					status: "running",
				});
				if (this.activities.length > AGENT_MAX_ACTIVITIES) this.activities.shift();
				break;
			case "tool_execution_end": {
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

	complete(status: TaskTerminalStatus, error: string | undefined, report: string): TaskCompletion<AgentToolDetails> {
		return {
			status,
			error,
			usage: this.usage,
			display: this.display(),
			result: {
				content: [{ type: "text", text: report }],
				details: { version: 2, state: status, taskId: this.control.id, ...(error ? { error } : {}) },
				...(status === "completed" ? {} : { isError: true }),
			},
		};
	}

	/** Model-readable progress: the report is the contract, so intermediate text never leaves the worker. */
	private status(): string {
		const latest = this.activities.at(-1);
		if (!latest) return "Agent running; no tool calls yet.";
		const calls = `${this.calls} tool ${this.calls === 1 ? "call" : "calls"}`;
		return `Agent running · ${calls} · latest: ${latest.name}${latest.target ? ` ${latest.target}` : ""}`;
	}

	/** Human-only Output: compact tool calls, never sent to the model. */
	private display(): string {
		return this.activities.length ? `Tool calls\n${activitiesText(this.activities)}` : "";
	}
}
