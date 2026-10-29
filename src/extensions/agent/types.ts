import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TaskTerminalStatus } from "../../core/tasks/types.ts";

export const AGENT_SETTINGS_NAMESPACE = "agent";
export const AGENT_REPORT_BYTES = 24 * 1024;
export const AGENT_MAX_ACTIVITIES = 50;

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

export interface AgentToolDetails {
	version: 1;
	taskId: string;
	status: "running" | "background" | TaskTerminalStatus;
	model: string;
	thinking: ThinkingLevel;
	/** Short terminal diagnostic; the complete report and error remain in Tasks Output. */
	error?: string;
	activities: AgentActivity[];
}

export function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
