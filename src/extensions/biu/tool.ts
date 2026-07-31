/**
 * biu/tool.ts — the model-facing `biu` tool.
 *
 * One tool, five actions. "get" returns the workflow snapshot plus the current
 * stage playbook; the mutating actions are the only write path into biu.json.
 * Markdown content (SPEC.md, TASK files, Summary.md) is written by the model
 * with the normal file tools; this tool never touches Markdown except for the
 * archive move (which rolls back on failure).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { buildBiuGetResponse, formatBiuStatusLine } from "./prompts.ts";
import {
	archiveBiuCycle,
	BIU_MAX_SHORTNAME_LENGTH,
	BIU_MAX_TASKS,
	BIU_MAX_TITLE_LENGTH,
	BIU_SPEC_STATUSES,
	BIU_STAGES,
	BIU_TASK_STATUSES,
	type BiuState,
	ensureBiuWorkspace,
	getBiuFocus,
	getStageTransitionError,
	getTaskCounts,
	isValidTaskId,
	saveBiuState,
	wouldCreateCycle,
} from "./state.ts";

export const BIU_TOOL_NAME = "biu";
export const BIU_TOOL_LABEL = "Biu";
export const BIU_DETAILS_SCHEMA_VERSION = 1;

export type BiuAction = "get" | "spec" | "task" | "stage" | "archive";
export type BiuTaskOp = "add" | "update" | "remove";

const ActionSchema = StringEnum(["get", "spec", "task", "stage", "archive"] as const, {
	description:
		'Biu operation: "get" loads the workflow snapshot and the current stage instructions (call this first each turn); "spec" updates SPEC metadata; "task" adds, updates, or removes a task entry; "stage" moves to another stage; "archive" atomically closes the cycle after Summary.md is confirmed.',
});

export const BiuToolParamsSchema = Type.Object({
	action: ActionSchema,
	specStatus: Type.Optional(
		StringEnum(BIU_SPEC_STATUSES, {
			description:
				'spec only: "ready" marks the SPEC approved (requires a recorded title and explicit user approval); "draft" reopens it.',
		}),
	),
	title: Type.Optional(
		Type.String({
			maxLength: BIU_MAX_TITLE_LENGTH,
			description: "spec only: short SPEC title.",
		}),
	),
	baselineCommit: Type.Optional(
		Type.String({
			maxLength: 80,
			description: 'spec only: Git commit hash the cycle starts from, or "none" without Git.',
		}),
	),
	op: Type.Optional(
		StringEnum(["add", "update", "remove"] as const, {
			description: "task only: add a new task entry, update an existing one, or remove one nothing depends on.",
		}),
	),
	id: Type.Optional(
		Type.String({
			maxLength: 85,
			description:
				'task only: task id in the form "TASK-" plus 1-80 ASCII letters, digits, dots, underscores, or hyphens. Must match the tasks/<id>.md filename.',
		}),
	),
	taskTitle: Type.Optional(
		Type.String({
			maxLength: BIU_MAX_TITLE_LENGTH,
			description: "task only: short task title. Required for add.",
		}),
	),
	status: Type.Optional(
		StringEnum(BIU_TASK_STATUSES, {
			description:
				'task only: new tasks always start "ready" (pass "ready" on add only when the caller requires a value); on update use "ready", "in_progress", or "completed".',
		}),
	),
	dependsOn: Type.Optional(
		Type.Array(Type.String({ maxLength: 85 }), {
			maxItems: 50,
			description:
				"task only: ids of tasks that must complete before this one. Replaces the full list on update; must resolve to existing tasks and stay acyclic.",
		}),
	),
	to: Type.Optional(
		StringEnum(BIU_STAGES, {
			description:
				"stage only: target stage. Backward moves are always allowed; decompose requires a ready SPEC and execute requires registered tasks.",
		}),
	),
	shortname: Type.Optional(
		Type.String({
			maxLength: BIU_MAX_SHORTNAME_LENGTH,
			description:
				"archive only: concise, filesystem-safe archive name derived from the SPEC title and main outcome, preserving the project's language.",
		}),
	),
	confirmIncomplete: Type.Optional(
		Type.Boolean({
			description:
				"archive only: must be true to archive while tasks are not completed, after the user explicitly chose to archive as-is.",
		}),
	),
});

export type BiuToolParams = Static<typeof BiuToolParamsSchema>;

function isBiuAction(value: unknown): value is BiuAction {
	return value === "get" || value === "spec" || value === "task" || value === "stage" || value === "archive";
}

function copyDefined(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
	if (source[key] !== undefined) target[key] = source[key];
}

function copyNonEmptyString(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
	const value = source[key];
	if (value === undefined || (typeof value === "string" && !value.trim())) return;
	target[key] = value;
}

/**
 * Project the provider-facing flat schema onto the fields used by one action.
 * Some tool-schema adapters materialize optional fields with neutral defaults;
 * removing unrelated values here keeps them from changing workflow state.
 */
export function normalizeBiuParams(input: unknown): BiuToolParams {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as BiuToolParams;
	const source = input as Record<string, unknown>;
	if (!isBiuAction(source.action)) return input as BiuToolParams;

	const target: Record<string, unknown> = { action: source.action };
	if (source.action === "get") return target as BiuToolParams;

	if (source.action === "spec") {
		copyDefined(source, target, "specStatus");
		copyNonEmptyString(source, target, "title");
		copyNonEmptyString(source, target, "baselineCommit");
		return target as BiuToolParams;
	}

	if (source.action === "stage") {
		copyDefined(source, target, "to");
		return target as BiuToolParams;
	}

	if (source.action === "archive") {
		copyNonEmptyString(source, target, "shortname");
		copyDefined(source, target, "confirmIncomplete");
		return target as BiuToolParams;
	}

	copyDefined(source, target, "op");
	copyNonEmptyString(source, target, "id");
	if (source.op === "add") {
		copyNonEmptyString(source, target, "taskTitle");
		copyDefined(source, target, "dependsOn");
		if (source.status !== undefined && source.status !== "ready") target.status = source.status;
	} else if (source.op === "update") {
		copyNonEmptyString(source, target, "taskTitle");
		copyDefined(source, target, "status");
		copyDefined(source, target, "dependsOn");
	}
	return target as BiuToolParams;
}

export interface BiuToolDetails {
	schemaVersion: typeof BIU_DETAILS_SCHEMA_VERSION;
	action: BiuAction;
	statusLine: string;
	archivedPath?: string;
}

export interface BiuToolOptions {
	isEnabled(): boolean;
	agentDir?(): string;
}

function requireParam<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

function summarizeTasks(state: BiuState): string {
	const counts = getTaskCounts(state);
	const parts = [
		`${counts.total} task(s)`,
		`${counts.ready} ready`,
		`${counts.inProgress} in progress`,
		`${counts.completed} completed`,
	];
	const focus = getBiuFocus(state);
	if (focus.kind === "active" || focus.kind === "next") parts.push(`focus ${focus.task.id}`);
	return parts.join(" · ");
}

function applySpecAction(state: BiuState, params: BiuToolParams): string {
	if (params.specStatus === undefined && params.title === undefined && params.baselineCommit === undefined) {
		throw new Error('The "spec" action requires at least one of specStatus, title, or baselineCommit.');
	}
	const notes: string[] = [];
	if (params.title !== undefined) {
		const title = params.title.trim();
		if (!title) throw new Error("SPEC title cannot be empty.");
		state.spec.title = title;
		notes.push(`title set to ${JSON.stringify(title)}`);
	}
	if (params.baselineCommit !== undefined) {
		const baseline = params.baselineCommit.trim();
		state.spec.baselineCommit = baseline || "none";
		notes.push(`baseline commit set to ${state.spec.baselineCommit}`);
	}
	if (params.specStatus !== undefined) {
		if (params.specStatus === "ready" && !state.spec.title) {
			throw new Error('Cannot mark the SPEC ready without a title. Set one first (spec action with "title").');
		}
		state.spec.status = params.specStatus;
		notes.push(`status set to ${params.specStatus}`);
	}
	return `SPEC updated: ${notes.join("; ")}.`;
}

function applyTaskAction(state: BiuState, params: BiuToolParams): string {
	const op = requireParam(params.op, 'The "task" action requires op: "add", "update", or "remove".');
	const id = requireParam(params.id, 'The "task" action requires the task id.').trim();
	if (!isValidTaskId(id)) {
		throw new Error(
			`Invalid task id ${JSON.stringify(id)}. Use "TASK-" plus 1-80 ASCII letters, digits, dots, underscores, or hyphens.`,
		);
	}
	const existing = state.tasks.find((task) => task.id === id);

	if (op === "add") {
		if (existing) throw new Error(`Task ${id} already exists. Use op "update" to change it.`);
		if (state.tasks.length >= BIU_MAX_TASKS) {
			throw new Error(`Cannot add ${id}: the cycle already has the maximum of ${BIU_MAX_TASKS} tasks.`);
		}
		const title = requireParam(params.taskTitle, 'Adding a task requires "taskTitle".').trim();
		if (!title) throw new Error("Task title cannot be empty.");
		if (params.status !== undefined && params.status !== "ready") {
			throw new Error('New tasks always start as "ready"; omit "status" or pass "ready" on add.');
		}
		const dependsOn = validateDependsOn(state, id, params.dependsOn ?? []);
		state.tasks.push({ id, title, status: "ready", dependsOn });
		return `Task ${id} added (${JSON.stringify(title)}${dependsOn.length ? `, depends on ${dependsOn.join(", ")}` : ""}). Also write its handoff file tasks/${id}.md if you have not already.`;
	}

	if (!existing) {
		throw new Error(
			`Task ${id} does not exist. Known tasks: ${state.tasks.map((task) => task.id).join(", ") || "none"}.`,
		);
	}

	if (op === "remove") {
		const dependents = state.tasks.filter((task) => task.dependsOn.includes(id)).map((task) => task.id);
		if (dependents.length > 0) {
			throw new Error(`Cannot remove ${id}: ${dependents.join(", ")} depend(s) on it. Update those first.`);
		}
		state.tasks = state.tasks.filter((task) => task.id !== id);
		return `Task ${id} removed. Delete tasks/${id}.md as well if it exists.`;
	}

	// op === "update"
	if (params.taskTitle === undefined && params.status === undefined && params.dependsOn === undefined) {
		throw new Error("Updating a task requires at least one of taskTitle, status, or dependsOn.");
	}
	const notes: string[] = [];
	if (params.taskTitle !== undefined) {
		const title = params.taskTitle.trim();
		if (!title) throw new Error("Task title cannot be empty.");
		existing.title = title;
		notes.push(`title set to ${JSON.stringify(title)}`);
	}
	if (params.dependsOn !== undefined) {
		existing.dependsOn = validateDependsOn(state, id, params.dependsOn);
		notes.push(`dependencies set to [${existing.dependsOn.join(", ")}]`);
	}
	let warning = "";
	if (params.status !== undefined) {
		existing.status = params.status;
		notes.push(`status set to ${params.status}`);
		if (params.status === "in_progress") {
			const others = state.tasks.filter((task) => task.status === "in_progress" && task.id !== id);
			if (others.length > 0) {
				warning = ` Warning: ${others.map((task) => task.id).join(", ")} is also in progress; Biu expects one task at a time unless the user asked otherwise.`;
			}
		}
	}
	return `Task ${id} updated: ${notes.join("; ")}.${warning}`;
}

function validateDependsOn(state: BiuState, id: string, dependsOn: string[]): string[] {
	const unique = [...new Set(dependsOn.map((dep) => dep.trim()))];
	for (const dep of unique) {
		if (dep === id) throw new Error(`Task ${id} cannot depend on itself.`);
		if (!state.tasks.some((task) => task.id === dep)) {
			throw new Error(
				`Dependency ${JSON.stringify(dep)} does not match any registered task. Add tasks in dependency order.`,
			);
		}
	}
	if (wouldCreateCycle(state.tasks, id, unique)) {
		throw new Error(`Setting these dependencies on ${id} would create a dependency cycle.`);
	}
	return unique;
}

export function createBiuTool(options: BiuToolOptions): ToolDefinition<typeof BiuToolParamsSchema, BiuToolDetails> {
	const agentDir = options.agentDir;
	return {
		name: BIU_TOOL_NAME,
		label: BIU_TOOL_LABEL,
		description:
			'Biu workflow state. Call with action "get" to load the current stage, task list, workspace paths, and stage instructions. Use the other actions to record state changes: "spec" for SPEC metadata, "task" for task entries, "stage" to move between stages, "archive" to close a confirmed cycle. This tool is the only way to change Biu workflow state; Markdown files carry content only.',
		parameters: BiuToolParamsSchema,
		prepareArguments: normalizeBiuParams,
		executionMode: "sequential",

		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<BiuToolDetails>> {
			if (!options.isEnabled()) {
				throw new Error("Biu Mode is not active in this session. The biu tool is only available while /biu is on.");
			}
			const dir = agentDir?.();
			const { paths, state } = await ensureBiuWorkspace(ctx.cwd, dir);

			if (params.action === "get") {
				return buildResult(params.action, buildBiuGetResponse(state, paths), state);
			}

			if (params.action === "archive") {
				const shortname = requireParam(params.shortname, 'The "archive" action requires a shortname.');
				const unfinished = state.tasks.filter((task) => task.status !== "completed");
				if (unfinished.length > 0 && params.confirmIncomplete !== true) {
					throw new Error(
						`Cannot archive: ${unfinished.map((task) => `${task.id} (${task.status})`).join(", ")} not completed. Ask the user whether to continue working, update statuses, or archive as-is; pass confirmIncomplete: true only after they explicitly choose to archive.`,
					);
				}
				const result = await archiveBiuCycle(ctx.cwd, shortname, dir);
				return buildResult(
					params.action,
					`Cycle archived to ${result.archivedPath}. A fresh cycle is ready at the interview stage.`,
					result.state,
					result.archivedPath,
				);
			}

			let message: string;
			if (params.action === "spec") {
				message = applySpecAction(state, params);
			} else if (params.action === "task") {
				message = applyTaskAction(state, params);
			} else {
				const to = requireParam(params.to, 'The "stage" action requires "to".');
				const error = getStageTransitionError(state, to);
				if (error) throw new Error(error);
				message = `Stage changed: ${state.stage} -> ${to}. Call biu with action "get" for the ${to} stage instructions.`;
				state.stage = to;
			}
			state.updatedAt = new Date().toISOString();
			await saveBiuState(ctx.cwd, state, dir);
			return buildResult(
				params.action,
				`${message}\n${formatBiuStatusLine(state)} · ${summarizeTasks(state)}`,
				state,
			);
		},
	};
}

function buildResult(
	action: BiuAction,
	text: string,
	state: BiuState,
	archivedPath?: string,
): AgentToolResult<BiuToolDetails> {
	const details: BiuToolDetails = {
		schemaVersion: BIU_DETAILS_SCHEMA_VERSION,
		action,
		statusLine: formatBiuStatusLine(state),
	};
	if (archivedPath !== undefined) details.archivedPath = archivedPath;
	return { content: [{ type: "text", text }], details };
}
