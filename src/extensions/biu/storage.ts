import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { cwdToSafeDirName, resolvePath } from "../../utils/paths.ts";
import { analyzeBiuWorkspace, type BiuAnalysis, type BiuSourceDocument } from "./stage.ts";

export const BIU_SPEC_FILE_NAME = "SPEC.md";
export const BIU_SUMMARY_FILE_NAME = "Summary.md";
export const BIU_TASKS_DIRECTORY_NAME = "tasks";
export const BIU_ARCHIVED_DIRECTORY_NAME = "archived";
export const BIU_MAX_DOCUMENT_BYTES = 256 * 1024;
export const BIU_MAX_TASK_FILES = 200;

export interface BiuWorkspacePaths {
	root: string;
	spec: string;
	summary: string;
	tasks: string;
	archived: string;
}

export interface BiuWorkspaceSnapshot extends BiuAnalysis {
	cwd: string;
	paths: BiuWorkspacePaths;
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function getBiuProjectDirectory(cwd: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "biu", cwdToSafeDirName(resolvePath(cwd)));
}

export function getBiuWorkspacePaths(cwd: string, agentDir: string = getAgentDir()): BiuWorkspacePaths {
	const root = getBiuProjectDirectory(cwd, agentDir);
	return {
		root,
		spec: join(root, BIU_SPEC_FILE_NAME),
		summary: join(root, BIU_SUMMARY_FILE_NAME),
		tasks: join(root, BIU_TASKS_DIRECTORY_NAME),
		archived: join(root, BIU_ARCHIVED_DIRECTORY_NAME),
	};
}

export async function ensureBiuWorkspace(cwd: string, agentDir: string = getAgentDir()): Promise<BiuWorkspacePaths> {
	const paths = getBiuWorkspacePaths(cwd, agentDir);
	await Promise.all([mkdir(paths.tasks, { recursive: true }), mkdir(paths.archived, { recursive: true })]);
	return paths;
}

async function regularFileExists(path: string, issues: string[]): Promise<boolean> {
	try {
		const metadata = await stat(path);
		if (metadata.isFile()) return true;
		issues.push(`${path}: expected a regular file`);
		return false;
	} catch (error) {
		if (isMissingFileError(error)) return false;
		issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

async function readBoundedDocument(path: string): Promise<BiuSourceDocument> {
	const metadata = await stat(path);
	if (!metadata.isFile()) throw new Error(`${path}: expected a regular file`);
	if (metadata.size > BIU_MAX_DOCUMENT_BYTES) {
		throw new Error(`${path}: exceeds ${BIU_MAX_DOCUMENT_BYTES} bytes`);
	}
	const content = await readFile(path, "utf8");
	if (Buffer.byteLength(content, "utf8") > BIU_MAX_DOCUMENT_BYTES) {
		throw new Error(`${path}: exceeds ${BIU_MAX_DOCUMENT_BYTES} bytes`);
	}
	return { path, content };
}

async function readOptionalDocument(path: string, issues: string[]): Promise<BiuSourceDocument | undefined> {
	try {
		return await readBoundedDocument(path);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		issues.push(error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

async function readTaskDocuments(paths: BiuWorkspacePaths, issues: string[]): Promise<BiuSourceDocument[]> {
	let names: string[];
	try {
		names = await readdir(paths.tasks);
	} catch (error) {
		if (isMissingFileError(error)) return [];
		issues.push(`${paths.tasks}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}

	const taskNames = names.filter((name) => name.startsWith("TASK-") && name.endsWith(".md")).sort();
	if (taskNames.length > BIU_MAX_TASK_FILES) {
		issues.push(`${paths.tasks}: contains ${taskNames.length} task files; maximum is ${BIU_MAX_TASK_FILES}`);
	}

	const documents: BiuSourceDocument[] = [];
	for (const name of taskNames.slice(0, BIU_MAX_TASK_FILES)) {
		const path = join(paths.tasks, name);
		try {
			documents.push(await readBoundedDocument(path));
		} catch (error) {
			issues.push(error instanceof Error ? error.message : String(error));
		}
	}
	return documents;
}

export async function scanBiuWorkspace(cwd: string, agentDir: string = getAgentDir()): Promise<BiuWorkspaceSnapshot> {
	const paths = getBiuWorkspacePaths(cwd, agentDir);
	const issues: string[] = [];
	const spec = await readOptionalDocument(paths.spec, issues);
	const tasks = await readTaskDocuments(paths, issues);
	const summaryExists = await regularFileExists(paths.summary, issues);
	const analysis = analyzeBiuWorkspace({ spec, tasks, summaryExists, issues });
	return { cwd: resolvePath(cwd), paths, ...analysis };
}
