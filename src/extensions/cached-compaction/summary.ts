import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";
import {
	type CompactionDetails,
	computeFileLists,
	type FileOperations,
	formatFileOperations,
} from "../../core/compaction/index.ts";
import { convertToLlm } from "../../core/messages.ts";
import { buildSessionProjection, getLatestCompactionEntry, type SessionEntry } from "../../core/session-manager.ts";

export interface KeptStart {
	text: string;
	fromEnd: number;
	count: number;
}

function sameMessage(candidate: Message, projected: AgentMessage): boolean {
	const serialized = JSON.stringify(candidate);
	return convertToLlm([projected]).some((message) => JSON.stringify(message) === serialized);
}

function messagePreview(message: Message): string | undefined {
	let text: string | undefined;
	if (message.role === "user") {
		text = contentText(message.content);
	} else if (message.role === "assistant") {
		text = message.content
			.flatMap((block) =>
				block.type === "text"
					? [block.text]
					: block.type === "toolCall"
						? [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`]
						: [],
			)
			.join("\n");
	}
	text = text?.trim();
	if (!text) return undefined;
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function keptStart(
	entries: SessionEntry[],
	firstKeptEntryId: string,
	conversation: Message[],
): KeptStart | undefined {
	const projected = buildSessionProjection(entries).entries;
	const start = projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	if (start === -1) return undefined;
	let at = -1;
	for (const message of projected.slice(start).flatMap((entry) => entry.messages)) {
		at = conversation.findLastIndex((candidate) => sameMessage(candidate, message));
		if (at !== -1) break;
	}
	if (at === -1) return undefined;
	const previews = conversation.slice(at).map(messagePreview);
	const text = previews[0];
	return text
		? { text, fromEnd: previews.filter((preview) => preview === text).length, count: previews.length }
		: undefined;
}

export function summaryInstruction(kept: KeptStart, customInstructions?: string): string {
	const repeated =
		kept.fromEnd > 1
			? ` Several retained messages begin with this text. The boundary is occurrence ${kept.fromEnd}, counting backward from the end of the conversation.`
			: "";
	const toolCalls = kept.text.includes("[tool call: ")
		? " Tool calls are written as [tool call: name arguments]."
		: "";
	const focus = customInstructions?.trim() ? `\n\nAdditional focus from the user:\n${customInstructions.trim()}` : "";
	return `Stop working on the current task. Do not call any tools.

Write a structured context checkpoint summary of the earlier part of this conversation. Another LLM will continue the task from your summary, followed by the last ${kept.count} messages, which will remain in context verbatim.

The retained messages begin with the message that starts with this text.${repeated}${toolCalls}

<kept-start>
${kept.text}
</kept-start>

Summarize only the messages before that boundary, as if the conversation had ended immediately before it. Work occurring at or after the boundary has not happened as far as this summary is concerned: do not list it as completed. If it was already planned, include it under Next Steps instead.

If the conversation contains an earlier checkpoint summary, fold its still-relevant facts into this summary and update its progress and next steps.

Use exactly this structure:

## Goal
[What the user is trying to accomplish. Include multiple goals if applicable.]

## Constraints & Preferences
- [Requirements, preferences, and explicit constraints from the user]
- [Use "(none)" when appropriate]

## Progress
### Done
- [x] [Work completed before the boundary]

### In Progress
- [ ] [Work underway at the boundary]

### Blocked
- [Issues preventing progress, or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered steps needed to continue]

## Critical Context
- [Exact information needed to continue: file paths, symbols, commands, important tool results, error messages, and relevant technical details]

Be concise but preserve information required to continue without rereading the original conversation. Keep exact file paths, function names, commands, and error messages. Do not include file-operation lists; they will be added automatically. Return only the summary.${focus}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function checkpointSummary(
	text: string,
	fileOps: FileOperations,
	entries: SessionEntry[],
): { summary: string; details: CompactionDetails } {
	const merged: FileOperations = {
		read: new Set(fileOps.read),
		written: new Set(fileOps.written),
		edited: new Set(fileOps.edited),
	};
	const previousDetails: unknown = getLatestCompactionEntry(entries)?.details;
	if (isPlainObject(previousDetails)) {
		const { readFiles, modifiedFiles } = previousDetails;
		if (Array.isArray(readFiles)) {
			for (const file of readFiles) if (typeof file === "string") merged.read.add(file);
		}
		if (Array.isArray(modifiedFiles)) {
			for (const file of modifiedFiles) if (typeof file === "string") merged.edited.add(file);
		}
	}
	const details = computeFileLists(merged);
	const body = text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim();
	const operations = formatFileOperations(details.readFiles, details.modifiedFiles);
	// The shared formatter prefixes a non-empty operation list; an empty summary body has no leading blank lines.
	return { summary: body ? body + operations : operations.slice(2), details };
}
