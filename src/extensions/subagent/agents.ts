import { DEFAULT_AGENT_TOOLS, EXPLORER_TOOLS, MAX_TASKS, type SubagentAgentName } from "./constants.ts";
import type { AgentProfile } from "./types.ts";

// Static display titles for the two built-in profiles; this file owns the
// model-facing copy, and renderers/commands share these labels.
export const AGENT_PROFILE_LABELS: Record<SubagentAgentName, string> = {
	explorer: "Explorer",
	general: "General",
};

export const AGENT_PROFILES: readonly AgentProfile[] = [
	{
		name: "explorer",
		description:
			'Fast read-only agent for finding files, searching code, and answering codebase questions. Can inspect git history (log, blame, diff) via read-only bash. State thoroughness in the prompt: "quick" for a targeted lookup, "medium" for checking likely related locations, or "very thorough" for exhaustive sweeps across locations and naming conventions',
		tools: [...EXPLORER_TOOLS],
		systemPrompt: [
			"You are a fast read-only exploration agent; return findings as quickly as possible.",
			"Explore the delegated question without modifying files.",
			"Use read and search tools to gather exact evidence, batching independent searches and reads instead of running them one at a time.",
			"bash is for read-only inspection only: git log/diff/blame/show/status, ls, wc, head, tail, cat, and similar.",
			"Never run anything that modifies state: no file creation or deletion, no redirect (>, >>) or heredoc writes, no temp files, no git commands that write (add, commit, checkout, restore, stash, clean), no installs, no network access.",
			"Match the depth the caller requested: quick targets the direct question, medium checks likely related locations, and very thorough sweeps multiple locations and naming conventions.",
			"Return concise findings with precise paths, symbols, relationships, and unresolved uncertainties.",
		].join("\n"),
		omitContextFiles: true,
	},
	{
		name: "general",
		description:
			"Implementation agent for bounded coding tasks: edits, fixes, refactors, and verification in a scoped area. Use when the task changes files; use explorer for read-only questions",
		tools: [...DEFAULT_AGENT_TOOLS],
		systemPrompt: [
			"Work independently on the delegated task from start to finish.",
			"Inspect relevant repository instructions before changing files.",
			"Prefer editing existing files; never create documentation files unless the task explicitly asks for them.",
			"Keep changes focused, run appropriate verification, and report exact paths, checks, blockers, and remaining risks.",
		].join("\n"),
	},
];

// Static model-facing guidance: there are exactly two profiles and one
// tasks-array parameter shape, so the description never depends on discovery.
// Concurrency and result ordering live on the tasks parameter; when-to-delegate
// routing lives in promptGuidelines. The self-contained-briefing rule is stated
// here as well as on the prompt parameter because it is the failure mode workers
// hit most often.
export function subagentToolDescription(): string {
	return [
		"Delegate bounded work to isolated one-shot subagents. Workers cannot see the parent conversation: each task needs a complete self-contained briefing, and you receive only their final reports.",
		"",
		`Provide 1-${MAX_TASKS} independent tasks; for sequential work, call this tool again with the previous result folded into the next briefing.`,
		"",
		"Agent profiles:",
		"- explorer (default): read-only investigation — finding files, searching code, and answering codebase questions; bash is restricted to read-only inspection (git log/diff/blame, ls, cat, and similar). Never use for changes.",
		"- general: implementation — edits, fixes, refactors, and verification in a scoped area; use when the task changes files.",
		"",
		"Never delegate with vague instructions: state what must be investigated or changed and the expected output.",
	].join("\n");
}
