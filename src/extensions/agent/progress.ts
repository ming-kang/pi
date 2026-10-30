import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { boundTail } from "../../core/tasks/output.ts";
import type { TaskCompletion, TaskControl, TaskTerminalStatus } from "../../core/tasks/types.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { activitiesText, activityTarget, clipText, compactArguments } from "./activity.ts";
import {
	AGENT_MAX_ACTIVITIES,
	AGENT_MAX_MESSAGES,
	AGENT_TEXT_BYTES,
	type AgentActivity,
	type AgentParentMessage,
	type AgentToolDetails,
} from "./types.ts";

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

export function assistantText(message: AgentMessage): string {
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

function appendText(current: string, addition: string): string {
	const text = addition.trim();
	if (!text) return current;
	const combined = current ? `${current}\n\n${text}` : text;
	if (Buffer.byteLength(combined) <= AGENT_TEXT_BYTES) return combined;
	const notice = "[Earlier Agent text omitted.]\n\n";
	return notice + boundTail(combined, AGENT_TEXT_BYTES - Buffer.byteLength(notice)).text;
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
 * One worker session translated into task progress: public assistant text for the model,
 * tool activity and parent messages for humans, and cumulative usage for the ledger.
 */
export class AgentProgress {
	private readonly control: TaskControl<AgentToolDetails>;
	private readonly activities: AgentActivity[] = [];
	private readonly messages: AgentParentMessage[] = [];
	private readonly counted = new WeakSet<AgentMessage>();
	private text = "";
	private usage: Usage = emptyUsage();
	private last?: AssistantMessage;
	/** Steering is accepted only while the worker's loop can still consume it. */
	private listening = false;

	constructor(control: TaskControl<AgentToolDetails>) {
		this.control = control;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.listening = true;
				return;
			case "agent_end":
				this.listening = false;
				return;
			case "message_end": {
				if (event.message.role !== "assistant") return;
				this.last = event.message;
				if (!this.counted.has(event.message)) {
					this.counted.add(event.message);
					this.usage = combineUsage(this.usage, event.message.usage);
				}
				const text = assistantText(event.message);
				if (!text.trim()) return;
				this.text = appendText(this.text, text);
				break;
			}
			case "compaction_end":
				if (event.result?.usage) this.usage = combineUsage(this.usage, event.result.usage);
				return;
			case "tool_execution_start":
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
				content: [{ type: "text", text: this.text }],
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

	/** The worker's message_parent tool. */
	sendToParent(text: string): boolean {
		if (!this.control.channel.send(text)) return false;
		this.record("agent", text);
		return true;
	}

	/** The task's steering handler: false once the worker can no longer consume steering. */
	async steer(session: AgentSession, text: string): Promise<boolean> {
		if (!this.listening) return false;
		if ((await session.steer(text, undefined, { source: "extension" })) !== "queued") return false;
		this.record("parent", text);
		return true;
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

	private record(from: AgentParentMessage["from"], text: string): void {
		this.messages.push({ from, text });
		if (this.messages.length > AGENT_MAX_MESSAGES) this.messages.shift();
		this.publish();
	}

	/** Human-only Output: parent messages and tool calls, never sent to the model. */
	private display(): string {
		const sections: string[] = [];
		if (this.messages.length)
			sections.push(
				`Parent messages\n${this.messages
					.map((message) => `${message.from === "agent" ? "Agent → Parent" : "Parent → Agent"}: ${message.text}`)
					.join("\n\n")}`,
			);
		if (this.activities.length) sections.push(`Tool calls\n${activitiesText(this.activities)}`);
		return sections.join("\n\n");
	}
}
