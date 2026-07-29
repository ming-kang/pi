import { parseFrontmatter } from "../../utils/frontmatter.ts";

export type BiuStage = "interview" | "decompose" | "execute" | "archive" | "repair";
export type BiuSpecStatus = "draft" | "ready";
export type BiuTaskStatus = "ready" | "in_progress" | "completed";

export interface BiuSourceDocument {
	path: string;
	content: string;
}

export interface BiuTask {
	id: string;
	title: string;
	status: BiuTaskStatus;
	dependsOn: string[];
	covers: string[];
	path: string;
}

export interface BiuTaskCounts {
	total: number;
	ready: number;
	inProgress: number;
	completed: number;
}

export interface BiuAnalysis {
	stage: BiuStage;
	specStatus?: BiuSpecStatus;
	specTitle?: string;
	acceptanceCriteria: string[];
	missingAcceptanceCriteria: string[];
	tasks: BiuTask[];
	taskCounts: BiuTaskCounts;
	activeTask?: BiuTask;
	nextTask?: BiuTask;
	summaryExists: boolean;
	issues: string[];
}

export interface AnalyzeBiuInput {
	spec?: BiuSourceDocument;
	tasks: BiuSourceDocument[];
	summaryExists: boolean;
	issues?: string[];
}

interface SpecFrontmatter extends Record<string, unknown> {
	title?: unknown;
	status?: unknown;
}

interface TaskFrontmatter extends Record<string, unknown> {
	id?: unknown;
	title?: unknown;
	status?: unknown;
	depends_on?: unknown;
}

interface ParsedSpec {
	status: BiuSpecStatus;
	title?: string;
	acceptanceCriteria: string[];
	unresolvedOpenQuestions: boolean;
	missingOpenQuestionsSection: boolean;
	missingAcceptanceCriteriaSection: boolean;
}

const SPEC_STATUSES = new Set<string>(["draft", "ready"]);
const TASK_STATUSES = new Set<string>(["ready", "in_progress", "completed"]);
const TASK_ID_PATTERN = /^TASK-[A-Za-z0-9._-]{1,80}$/;
const UNCHECKED_ITEM_PATTERN = /^\s*[-*]\s+\[\s\]/m;
const ACCEPTANCE_CRITERION_PATTERN = /^\s*[-*]\s+\[[ xX]\]\s+AC(\d+)\s*:/gim;
const COVER_PATTERN = /^\s*[-*]\s+AC(\d+)\b/gim;

function isSpecStatus(value: unknown): value is BiuSpecStatus {
	return typeof value === "string" && SPEC_STATUSES.has(value);
}

function isTaskStatus(value: unknown): value is BiuTaskStatus {
	return typeof value === "string" && TASK_STATUSES.has(value);
}

function normalizeAcceptanceCriterionId(value: string): string | undefined {
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= 1 ? `AC${number}` : undefined;
}

function extractSection(body: string, title: string): string | undefined {
	const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const expected = title.toLowerCase();
	let start = -1;
	for (let index = 0; index < lines.length; index++) {
		const heading = /^##\s+(.+)$/.exec(lines[index].trim());
		if (heading?.[1]?.trim().toLowerCase() === expected) {
			start = index + 1;
			break;
		}
	}
	if (start === -1) return undefined;
	let end = lines.length;
	for (let index = start; index < lines.length; index++) {
		if (/^#{1,2}\s+\S/.test(lines[index].trim())) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join("\n").trim();
}

function extractIds(text: string, pattern: RegExp): { ids: string[]; duplicates: string[]; invalid: string[] } {
	const ids: string[] = [];
	const duplicates: string[] = [];
	const invalid: string[] = [];
	for (const match of text.matchAll(pattern)) {
		const raw = match[1];
		if (!raw) continue;
		const id = normalizeAcceptanceCriterionId(raw);
		if (!id) {
			invalid.push(`AC${raw}`);
			continue;
		}
		if (ids.includes(id)) {
			if (!duplicates.includes(id)) duplicates.push(id);
			continue;
		}
		ids.push(id);
	}
	return { ids, duplicates, invalid };
}

function parseSpec(document: BiuSourceDocument, issues: string[]): ParsedSpec | undefined {
	let parsed: ReturnType<typeof parseFrontmatter<SpecFrontmatter>>;
	try {
		parsed = parseFrontmatter<SpecFrontmatter>(document.content);
	} catch (error) {
		issues.push(
			`${document.path}: invalid YAML frontmatter (${error instanceof Error ? error.message : String(error)})`,
		);
		return undefined;
	}

	const status = parsed.frontmatter.status;
	if (!isSpecStatus(status)) {
		issues.push(`${document.path}: status must be draft or ready`);
		return undefined;
	}

	const rawTitle = parsed.frontmatter.title;
	const title = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : undefined;
	const openQuestions = extractSection(parsed.body, "Open Questions");
	const acceptanceCriteriaSection = extractSection(parsed.body, "Acceptance Criteria");
	const acceptanceCriteria = acceptanceCriteriaSection
		? extractIds(acceptanceCriteriaSection, ACCEPTANCE_CRITERION_PATTERN)
		: { ids: [], duplicates: [], invalid: [] };
	for (const invalid of acceptanceCriteria.invalid) {
		issues.push(`${document.path}: invalid acceptance criterion ${invalid}`);
	}
	for (const duplicate of acceptanceCriteria.duplicates) {
		issues.push(`${document.path}: duplicate acceptance criterion ${duplicate}`);
	}

	return {
		status,
		...(title ? { title } : {}),
		acceptanceCriteria: acceptanceCriteria.ids,
		unresolvedOpenQuestions: openQuestions !== undefined && UNCHECKED_ITEM_PATTERN.test(openQuestions),
		missingOpenQuestionsSection: openQuestions === undefined,
		missingAcceptanceCriteriaSection: acceptanceCriteriaSection === undefined,
	};
}

function parseDependsOn(value: unknown, path: string, issues: string[]): string[] | undefined {
	if (!Array.isArray(value)) {
		issues.push(`${path}: depends_on must be an array`);
		return undefined;
	}
	const dependencies: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || !item.trim()) {
			issues.push(`${path}: depends_on must contain non-empty task ids`);
			return undefined;
		}
		const id = item.trim();
		if (!TASK_ID_PATTERN.test(id)) {
			issues.push(`${path}: depends_on must contain portable TASK-* ids of at most 85 characters`);
			return undefined;
		}
		if (!dependencies.includes(id)) dependencies.push(id);
	}
	return dependencies;
}

function parseTask(document: BiuSourceDocument, issues: string[]): BiuTask | undefined {
	let parsed: ReturnType<typeof parseFrontmatter<TaskFrontmatter>>;
	try {
		parsed = parseFrontmatter<TaskFrontmatter>(document.content);
	} catch (error) {
		issues.push(
			`${document.path}: invalid YAML frontmatter (${error instanceof Error ? error.message : String(error)})`,
		);
		return undefined;
	}

	const rawId = parsed.frontmatter.id;
	const id = typeof rawId === "string" ? rawId.trim() : "";
	if (!TASK_ID_PATTERN.test(id)) {
		issues.push(`${document.path}: id must be a portable TASK-* value of at most 85 characters`);
		return undefined;
	}

	const expectedFileName = `${id}.md`;
	const actualFileName = document.path.replace(/\\/g, "/").split("/").pop();
	if (actualFileName !== expectedFileName) {
		issues.push(`${document.path}: filename must match task id (${expectedFileName})`);
	}

	const rawTitle = parsed.frontmatter.title;
	if (typeof rawTitle !== "string" || !rawTitle.trim()) {
		issues.push(`${document.path}: title must be a non-empty string`);
		return undefined;
	}

	const status = parsed.frontmatter.status;
	if (!isTaskStatus(status)) {
		issues.push(`${document.path}: status must be ready, in_progress, or completed`);
		return undefined;
	}

	const dependsOn = parseDependsOn(parsed.frontmatter.depends_on, document.path, issues);
	if (!dependsOn) return undefined;

	const coversSection = extractSection(parsed.body, "Covers");
	if (coversSection === undefined) {
		issues.push(`${document.path}: missing ## Covers section`);
		return undefined;
	}
	const extractedCovers = extractIds(coversSection, COVER_PATTERN);
	for (const invalid of extractedCovers.invalid) {
		issues.push(`${document.path}: invalid Covers reference ${invalid}`);
	}
	const covers = extractedCovers.ids;
	if (covers.length === 0) {
		issues.push(`${document.path}: ## Covers must reference at least one AC id`);
	}

	return {
		id,
		title: rawTitle.trim(),
		status,
		dependsOn,
		covers,
		path: document.path,
	};
}

function emptyTaskCounts(): BiuTaskCounts {
	return { total: 0, ready: 0, inProgress: 0, completed: 0 };
}

function countTasks(tasks: BiuTask[]): BiuTaskCounts {
	const counts = emptyTaskCounts();
	counts.total = tasks.length;
	for (const task of tasks) {
		if (task.status === "ready") counts.ready++;
		else if (task.status === "in_progress") counts.inProgress++;
		else counts.completed++;
	}
	return counts;
}

function graphHasCycle(tasks: BiuTask[]): boolean {
	const dependencyCounts = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const task of tasks) {
		dependencyCounts.set(task.id, task.dependsOn.length);
		for (const dependency of task.dependsOn) {
			const current = dependents.get(dependency) ?? [];
			current.push(task.id);
			dependents.set(dependency, current);
		}
	}

	const queue = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
	let visited = 0;
	for (let index = 0; index < queue.length; index++) {
		const id = queue[index];
		visited++;
		for (const dependent of dependents.get(id) ?? []) {
			const remaining = (dependencyCounts.get(dependent) ?? 0) - 1;
			dependencyCounts.set(dependent, remaining);
			if (remaining === 0) queue.push(dependent);
		}
	}
	return visited !== tasks.length;
}

function validateTasks(tasks: BiuTask[], acceptanceCriteria: string[], issues: string[]): void {
	const tasksById = new Map<string, BiuTask>();
	for (const task of tasks) {
		if (tasksById.has(task.id)) issues.push(`duplicate task id ${task.id}`);
		else tasksById.set(task.id, task);
	}

	let graphReferencesValid = tasksById.size === tasks.length;
	for (const task of tasks) {
		for (const dependency of task.dependsOn) {
			if (dependency === task.id) {
				issues.push(`${task.path}: task cannot depend on itself`);
				graphReferencesValid = false;
			} else if (!tasksById.has(dependency)) {
				issues.push(`${task.path}: dependency ${dependency} does not exist`);
				graphReferencesValid = false;
			}
		}
		for (const criterion of task.covers) {
			if (!acceptanceCriteria.includes(criterion)) {
				issues.push(`${task.path}: Covers references unknown ${criterion}`);
			}
		}
	}

	if (graphReferencesValid && graphHasCycle(tasks)) issues.push("task dependency graph contains a cycle");

	const activeTasks = tasks.filter((task) => task.status === "in_progress");
	if (activeTasks.length > 1) {
		issues.push(`multiple tasks are in_progress: ${activeTasks.map((task) => task.id).join(", ")}`);
	}

	for (const task of tasks) {
		if (task.status === "ready") continue;
		for (const dependencyId of task.dependsOn) {
			const dependency = tasksById.get(dependencyId);
			if (dependency && dependency.status !== "completed") {
				issues.push(`${task.path}: ${task.status} task depends on incomplete ${dependencyId}`);
			}
		}
	}
}

function findNextTask(tasks: BiuTask[]): BiuTask | undefined {
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	return tasks.find(
		(task) =>
			task.status === "ready" &&
			task.dependsOn.every((dependencyId) => tasksById.get(dependencyId)?.status === "completed"),
	);
}

function result(options: {
	stage: BiuStage;
	spec?: ParsedSpec;
	tasks: BiuTask[];
	summaryExists: boolean;
	issues: string[];
	missingAcceptanceCriteria?: string[];
}): BiuAnalysis {
	const taskCounts = countTasks(options.tasks);
	return {
		stage: options.stage,
		...(options.spec ? { specStatus: options.spec.status } : {}),
		...(options.spec?.title ? { specTitle: options.spec.title } : {}),
		acceptanceCriteria: options.spec?.acceptanceCriteria ?? [],
		missingAcceptanceCriteria: options.missingAcceptanceCriteria ?? [],
		tasks: options.tasks,
		taskCounts,
		activeTask: options.tasks.find((task) => task.status === "in_progress"),
		nextTask: findNextTask(options.tasks),
		summaryExists: options.summaryExists,
		issues: options.issues,
	};
}

export function analyzeBiuWorkspace(input: AnalyzeBiuInput): BiuAnalysis {
	const issues = [...(input.issues ?? [])];
	const tasks = input.tasks
		.map((document) => parseTask(document, issues))
		.filter((task): task is BiuTask => task !== undefined)
		.sort((first, second) => (first.id < second.id ? -1 : first.id > second.id ? 1 : 0));

	if (!input.spec) {
		if (input.tasks.length > 0) issues.push("tasks exist without SPEC.md");
		if (input.summaryExists) issues.push("Summary.md exists without SPEC.md");
		return result({
			stage: issues.length > 0 ? "repair" : "interview",
			tasks,
			summaryExists: input.summaryExists,
			issues,
		});
	}

	const spec = parseSpec(input.spec, issues);
	if (!spec) {
		return result({ stage: "repair", tasks, summaryExists: input.summaryExists, issues });
	}

	if (spec.status === "draft") {
		if (input.tasks.length > 0) issues.push("tasks exist while SPEC.md is still draft");
		if (input.summaryExists) issues.push("Summary.md exists while SPEC.md is still draft");
		return result({
			stage: issues.length > 0 ? "repair" : "interview",
			spec,
			tasks,
			summaryExists: input.summaryExists,
			issues,
		});
	}

	if (!spec.title) issues.push(`${input.spec.path}: ready SPEC must have a title`);
	if (spec.missingOpenQuestionsSection) issues.push(`${input.spec.path}: ready SPEC is missing ## Open Questions`);
	if (spec.unresolvedOpenQuestions) issues.push(`${input.spec.path}: ready SPEC has unresolved open questions`);
	if (spec.missingAcceptanceCriteriaSection) {
		issues.push(`${input.spec.path}: ready SPEC is missing ## Acceptance Criteria`);
	} else if (spec.acceptanceCriteria.length === 0) {
		issues.push(`${input.spec.path}: ready SPEC must define at least one AC id`);
	}

	validateTasks(tasks, spec.acceptanceCriteria, issues);
	if (issues.length > 0) {
		return result({ stage: "repair", spec, tasks, summaryExists: input.summaryExists, issues });
	}

	if (tasks.length === 0) {
		if (input.summaryExists) issues.push("Summary.md exists without tasks");
		return result({
			stage: issues.length > 0 ? "repair" : "decompose",
			spec,
			tasks,
			summaryExists: input.summaryExists,
			issues,
		});
	}

	const covered = new Set(tasks.flatMap((task) => task.covers));
	const missingAcceptanceCriteria = spec.acceptanceCriteria.filter((criterion) => !covered.has(criterion));
	if (missingAcceptanceCriteria.length > 0) {
		const decompositionStillDraft = tasks.every((task) => task.status === "ready") && !input.summaryExists;
		if (!decompositionStillDraft) {
			issues.push(`task set started execution before covering ${missingAcceptanceCriteria.join(", ")}`);
		}
		return result({
			stage: issues.length > 0 ? "repair" : "decompose",
			spec,
			tasks,
			summaryExists: input.summaryExists,
			issues,
			missingAcceptanceCriteria,
		});
	}

	if (input.summaryExists || tasks.every((task) => task.status === "completed")) {
		return result({ stage: "archive", spec, tasks, summaryExists: input.summaryExists, issues });
	}

	return result({ stage: "execute", spec, tasks, summaryExists: input.summaryExists, issues });
}
