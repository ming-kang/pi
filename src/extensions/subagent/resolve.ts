import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { AGENT_PROFILES } from "./agents.ts";
import { findAvailableModel } from "./model-selection.ts";
import type { SubagentTask } from "./schema.ts";
import { loadSubagentConfig } from "./settings.ts";
import { firstPlainLine, truncate } from "./text.ts";
import type { ResolvedSubagentTask, SubagentConfigFile, SubagentProfileOverride } from "./types.ts";

export interface ParentModelContext {
	model: Model<Api> | undefined;
	thinking: ThinkingLevel;
	modelRegistry: Pick<ModelRegistry, "find" | "getAvailable" | "hasConfiguredAuth">;
}

function normalizeCwdInput(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) throw new Error("cwd must not be empty.");
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function isWithin(parent: string, child: string): boolean {
	const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
	const normalizedChild = process.platform === "win32" ? child.toLowerCase() : child;
	const rest = relative(normalizedParent, normalizedChild);
	return rest === "" || (rest !== ".." && !rest.startsWith(`..${PATH_SEP}`) && !isAbsolute(rest));
}

const PATH_SEP = process.platform === "win32" ? "\\" : "/";

export function resolveTaskCwd(parentCwd: string, requestedCwd: string | undefined): string {
	const value = normalizeCwdInput(requestedCwd);
	// Models routinely echo the parent working directory back as an absolute
	// path; accept an absolute cwd that stays inside the parent instead of
	// failing the whole task over path style.
	const absolute = value !== undefined && isAbsolute(value);
	const candidate = absolute ? resolve(value) : resolve(parentCwd, value ?? ".");
	// Relative inputs get a lexical traversal check before touching the file
	// system. Absolute inputs may use the real spelling of a symlinked parent,
	// so their containment is decided by the canonical check below.
	if (!absolute && !isWithin(resolve(parentCwd), candidate))
		throw new Error(`Subagent cwd escapes the parent working directory: ${requestedCwd}`);
	if (!existsSync(candidate) || !statSync(candidate).isDirectory())
		throw new Error(`Subagent cwd is not a directory: ${candidate}`);
	const realParent = realpathSync(parentCwd);
	const realCandidate = realpathSync(candidate);
	if (!isWithin(realParent, realCandidate)) {
		if (absolute) throw new Error("cwd must stay inside the parent working directory.");
		throw new Error(`Subagent cwd escapes the parent working directory: ${requestedCwd}`);
	}
	return realCandidate;
}

// Exactly two layers: a /agents override wins, otherwise the subagent
// inherits the parent session. Callers and agent files cannot pick models.
function resolveModel(override: SubagentProfileOverride | undefined, parent: ParentModelContext): Model<Api> {
	if (override?.model) return findAvailableModel(override.model, parent.modelRegistry);
	if (!parent.model) throw new Error("The parent session has no active model.");
	return parent.model;
}

function resolveThinking(
	override: SubagentProfileOverride | undefined,
	parent: ParentModelContext,
	model: Model<Api>,
): ThinkingLevel {
	const requested = override?.thinking ?? parent.thinking;
	return clampThinkingLevel(model, requested) as ThinkingLevel;
}

// The schema restricts task.agent to explorer|general; an omitted or null
// agent resolves to the read-only explorer profile.
const DEFAULT_AGENT_NAME = "explorer";

// An explicit short label wins; otherwise derive a bounded plain-text label from
// the briefing's first meaningful line so UI rows and report headings stay readable.
export function taskLabel(task: Pick<SubagentTask, "prompt"> & { description?: string | null }): string {
	const explicit = task.description?.trim();
	if (explicit) return explicit;
	return truncate(firstPlainLine(task.prompt), 80);
}

/** Group title shown in the /bg list, status line, and completion notification. */
export function subagentGroupTitle(tasks: readonly SubagentTask[]): string {
	const labels = tasks.map((task) => taskLabel(task));
	if (labels.length === 1) return truncate(`Subagent · ${labels[0]}`, 100);
	return truncate(`Subagent · ${tasks.length} tasks: ${labels.join(", ")}`, 100);
}

export async function resolveSubagentTask(
	task: SubagentTask,
	parentCwd: string,
	parent: ParentModelContext,
	configAgentDir = getAgentDir(),
	preloadedConfig?: SubagentConfigFile,
): Promise<ResolvedSubagentTask> {
	const agentName = task.agent ?? DEFAULT_AGENT_NAME;
	const agent = AGENT_PROFILES.find((candidate) => candidate.name === agentName);
	if (!agent) {
		const available = AGENT_PROFILES.map((candidate) => candidate.name).join(", ") || "none";
		throw new Error(`Unknown agent "${agentName}". Available agents: ${available}.`);
	}
	const config = preloadedConfig ?? (await loadSubagentConfig(configAgentDir));
	const override = config.profiles[agent.name];
	const model = resolveModel(override, parent);
	return {
		agent,
		description: taskLabel(task),
		prompt: task.prompt,
		cwd: resolveTaskCwd(parentCwd, task.cwd ?? undefined),
		model,
		thinking: resolveThinking(override, parent, model),
	};
}
