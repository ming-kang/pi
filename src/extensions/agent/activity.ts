import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { boundTail, boundText } from "../../core/tasks/output.ts";
import { AGENT_REPORT_BYTES, AGENT_TEXT_BYTES, type AgentActivity, type AgentSupervisorMessage } from "./types.ts";

export function clipText(text: string, bytes: number): string {
	if (Buffer.byteLength(text) <= bytes) return text;
	return `${boundText(text, Math.max(1, bytes - 1))}…`;
}

export function compactArguments(args: unknown): string {
	try {
		return clipText(JSON.stringify(args) ?? String(args), 512).replace(/\s+/gu, " ");
	} catch {
		return "{…}";
	}
}

/** A short display target; full arguments remain available in Tasks Output. */
export function activityTarget(name: string, args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return compactArguments(args);
	const record = args as Record<string, unknown>;
	const keys =
		name === "bash" || name === "powershell"
			? ["command"]
			: name === "grep" || name === "find"
				? ["pattern", "path"]
				: ["path", "pattern", "command"];
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string" || !value.trim()) continue;
		const first = key === "command" ? value.split(/\r?\n/).find((line) => line.trim()) : value;
		return clipText((first ?? value).trim().replace(/[ \t]+/gu, " "), 160);
	}
	return compactArguments(args);
}

export function formatActivityDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function activityGlyph(status: AgentActivity["status"]): string {
	switch (status) {
		case "running":
			return "…";
		case "ok":
			return "✓";
		case "error":
			return "✗";
		case "cancelled":
			return "⊘";
	}
}

export function activityText(activity: AgentActivity, includeError = true): string {
	const duration = formatActivityDuration(activity.durationMs);
	const line = `${activityGlyph(activity.status)} ${activity.name}${activity.args ? ` ${activity.args}` : ""}${duration ? ` ${duration}` : ""}`;
	return includeError && activity.error
		? `${line}\n    ${clipText(activity.error, 1000).replaceAll("\n", "\n    ")}`
		: line;
}

export function activitiesText(activities: readonly AgentActivity[]): string {
	return activities.map((activity) => activityText(activity)).join("\n");
}

export function boundedAgentText(text: string, maxBytes = AGENT_REPORT_BYTES, fullOutputPath?: string): string {
	const notice = fullOutputPath
		? `\n\n[Agent output truncated. Full output: ${fullOutputPath}]`
		: "\n\n[Agent output truncated. Full output unavailable.]";
	if (Buffer.byteLength(text) <= maxBytes) return text;
	return boundText(text, maxBytes - Buffer.byteLength(notice)) + notice;
}

export function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function appendAgentText(current: string, addition: string): string {
	const text = addition.trim();
	if (!text) return current;
	const combined = current ? `${current}\n\n${text}` : text;
	if (Buffer.byteLength(combined) <= AGENT_TEXT_BYTES) return combined;
	const notice = "[Earlier Agent text omitted.]\n\n";
	return notice + boundTail(combined, AGENT_TEXT_BYTES - Buffer.byteLength(notice)).text;
}

export function agentDisplayText(
	messages: readonly AgentSupervisorMessage[],
	activities: readonly AgentActivity[],
): string {
	const sections: string[] = [];
	if (messages.length)
		sections.push(
			`Supervisor messages\n${messages
				.map((message) => `${message.direction === "outbound" ? "Agent → Main" : "Main → Agent"}: ${message.text}`)
				.join("\n\n")}`,
		);
	if (activities.length) sections.push(`Tool calls\n${activitiesText(activities)}`);
	return sections.join("\n\n");
}

export function finalAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]!);
		if (text.trim()) return text;
	}
	return "";
}
