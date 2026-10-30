import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TaskTerminalStatus } from "../../core/tasks/types.ts";

export const AGENT_SETTINGS_NAMESPACE = "agent";
export const AGENT_PROMPT_BYTES = 16 * 1024;
export const AGENT_REPORT_BYTES = 24 * 1024;
export const AGENT_MAX_ACTIVITIES = 50;
export const AGENT_MAX_MESSAGES = 20;
export const AGENT_TEXT_BYTES = 48 * 1024;
export const AGENT_CONCURRENCY = 4;

export interface AgentSettings {
	model?: string;
	thinking?: ThinkingLevel;
}

export type AgentActivityStatus = "running" | "ok" | "error" | "cancelled";

export interface AgentActivity {
	id: string;
	name: string;
	args: string;
	/** Short display label derived from the original arguments; args remains the full bounded form. */
	target?: string;
	status: AgentActivityStatus;
	durationMs?: number;
	error?: string;
}

/** One explicit exchange between a running Agent and the parent that delegated to it. */
export interface AgentParentMessage {
	from: "agent" | "parent";
	text: string;
}

/**
 * Agent tool-result details. Only progress updates carry activities; the persisted result
 * keeps the transcript row's facts, and the full history lives in the task's Output.
 */
export type AgentToolDetails =
	| { version: 2; state: "running"; taskId: string; activities: AgentActivity[] }
	| { version: 2; state: "background"; taskId: string; byUser: boolean }
	| { version: 2; state: TaskTerminalStatus; taskId: string; error?: string };
