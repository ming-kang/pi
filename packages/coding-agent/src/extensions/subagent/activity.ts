import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { ACTIVITY_LIMIT, ACTIVITY_TEXT_LIMIT, LIVE_TEXT_LIMIT, SINGLE_OUTPUT_LIMIT } from "./constants.ts";
import type { SubagentUsage, ToolActivity } from "./types.ts";

export function emptyUsage(): SubagentUsage {
	return {
		turns: 0,
		toolUses: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

export function addUsage(target: SubagentUsage, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input ?? 0;
	target.output += usage.output ?? 0;
	target.cacheRead += usage.cacheRead ?? 0;
	target.cacheWrite += usage.cacheWrite ?? 0;
	target.totalTokens += usage.totalTokens ?? 0;
	target.cost += usage.cost?.total ?? 0;
}

export function mergeUsage(target: SubagentUsage, source: SubagentUsage): void {
	target.turns += source.turns;
	target.toolUses += source.toolUses;
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.totalTokens += source.totalTokens;
	target.cost += source.cost;
}

export function toNestedUsage(usage: SubagentUsage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let output = text.slice(0, maxBytes);
	while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
	return output;
}

export function boundText(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = utf8Prefix(text, maxBytes);
	for (let attempt = 0; attempt < 8; attempt++) {
		const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(output, "utf8");
		const notice = `\n\n[Output truncated: ${omitted} bytes omitted.]`;
		const available = maxBytes - Buffer.byteLength(notice, "utf8");
		if (available <= 0) return utf8Prefix("[Output truncated.]", maxBytes);
		const next = utf8Prefix(text, available);
		if (next === output) return `${output}${notice}`;
		output = next;
	}
	const omitted = Buffer.byteLength(text, "utf8") - Buffer.byteLength(output, "utf8");
	const notice = `\n\n[Output truncated: ${omitted} bytes omitted.]`;
	return `${utf8Prefix(output, Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8")))}${notice}`;
}

export function tailText(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let output = text.slice(-maxBytes);
	while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(1);
	return `[Earlier output omitted.]\n${output}`;
}

export function assistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export function finalAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const text = assistantText(messages[index]);
		if (text) return boundText(text, SINGLE_OUTPUT_LIMIT);
	}
	return "";
}

export function appendActivity(activities: ToolActivity[], activity: ToolActivity): void {
	activities.push(activity);
	while (activities.length > ACTIVITY_LIMIT) activities.shift();
	while (
		activities.reduce((total, item) => total + item.summary.length + (item.resultSummary?.length ?? 0), 0) >
		ACTIVITY_TEXT_LIMIT
	) {
		if (activities.length <= 1) break;
		activities.shift();
	}
}

export function setLiveText(text: string): string {
	return tailText(text, LIVE_TEXT_LIMIT);
}

export function activitySummary(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return toolName;
	const input = args as Record<string, unknown>;
	const path =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	if (toolName === "bash" && typeof input.command === "string")
		return `Run ${boundText(input.command.replace(/\s+/gu, " "), 160)}`;
	if (path) return `${toolName} ${boundText(path, 180)}`;
	if (toolName === "grep" && typeof input.pattern === "string") return `Search ${boundText(input.pattern, 120)}`;
	if (toolName === "find" && typeof input.pattern === "string") return `Find ${boundText(input.pattern, 120)}`;
	return toolName;
}

export function resultSummary(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return boundText(
		content
			.filter((part): part is { type: "text"; text: string } => {
				return Boolean(
					part &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				);
			})
			.map((part) => part.text)
			.join("\n")
			.replace(/\s+/gu, " ")
			.trim(),
		240,
	);
}
