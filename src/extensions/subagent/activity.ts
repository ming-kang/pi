import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { TASK_OUTPUT_LIMIT } from "./constants.ts";
import { boundText } from "./text.ts";
import type { SubagentUsage } from "./types.ts";

/** The usage fields that are summed when aggregating. */
export const USAGE_SUM_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

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
	for (const field of USAGE_SUM_FIELDS) target[field] += usage[field] ?? 0;
	target.cost += usage.cost?.total ?? 0;
	// Watermark, not a sum: the latest request's total is the context size,
	// and it can shrink again after the worker auto-compacts.
	if (usage.totalTokens) target.contextTokens = usage.totalTokens;
}

export function mergeUsage(target: SubagentUsage, source: SubagentUsage): void {
	target.turns += source.turns;
	target.toolUses += source.toolUses;
	for (const field of USAGE_SUM_FIELDS) target[field] += source[field];
	target.cost += source.cost;
	if (source.contextTokens) {
		target.contextTokens = Math.max(target.contextTokens ?? 0, source.contextTokens);
	}
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
		if (text) return boundText(text, TASK_OUTPUT_LIMIT);
	}
	return "";
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

export function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * Activity summary for the synthetic auto-compaction entry. The before/after
 * pair is only known once a compaction succeeds; a failed or aborted one keeps
 * the neutral label and carries its reason in the entry's resultSummary.
 */
export function compactionSummary(tokensBefore: number | undefined, tokensAfter: number | undefined): string {
	if (tokensBefore && tokensAfter) return `Compacted ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)}`;
	return "Compact context";
}

/** Failure reason for the compaction activity; bounded like {@link resultSummary}. */
export function compactionError(error: string): string {
	return boundText(error.replace(/\s+/gu, " ").trim(), 240);
}

/**
 * Extracts a short text summary from a tool result's content array.
 * Accepts `unknown` because SDK event payloads carry loosely-typed result
 * objects; the function defensively narrows to the text-content shape.
 */
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
