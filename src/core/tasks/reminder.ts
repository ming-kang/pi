import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { boundText } from "./output.ts";
import type { TaskRuntime } from "./runtime.ts";
import { isTaskTerminal, type TaskSnapshot } from "./types.ts";

function taskLine(task: TaskSnapshot): string {
	const title = boundText(task.title.replace(/\s+/gu, " ").trim(), 240);
	return boundText(`${task.id} ${task.kind} ${task.status} ${title}`, 1024);
}

/**
 * A one-shot, request-local reminder after compaction. It is never persisted and
 * creates no turn. Failed requests keep it eligible; an assistant response consumes it.
 */
export class TaskContextReminder {
	private pending = false;
	private projected = false;

	compacted(): void {
		this.pending = true;
		this.projected = false;
	}

	project(service: TaskRuntime, messages: AgentMessage[]): AgentMessage[] {
		if (!this.pending) return messages;
		const tasks = service.list().filter((task) => task.mode === "background" && !isTaskTerminal(task.status));
		if (tasks.length === 0) {
			this.reset();
			return messages;
		}
		const reminder: AgentMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: [
						"Context was compacted. These background tasks are still active; do not start duplicates.",
						"Use tasks list/read/wait/kill to inspect or control them. Completion arrives automatically.",
						...tasks.map(taskLine),
					].join("\n"),
				},
			],
			timestamp: Date.now(),
		};
		this.projected = true;
		return [...messages, reminder];
	}

	assistantCompleted(): void {
		if (this.projected) this.reset();
	}

	reset(): void {
		this.pending = false;
		this.projected = false;
	}
}
