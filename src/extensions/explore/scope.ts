import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools } from "../../core/tools/index.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";

function assertWithin(root: string, target: string): void {
	const path = relative(root, target);
	if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
		throw new Error("Path is outside the Explore scope");
	}
}

export async function resolveExploreScope(cwd: string, path = "."): Promise<string> {
	if (isAbsolute(path)) throw new Error("Explore scope must be relative to the working directory");
	assertWithin(resolve(cwd), resolve(cwd, path));
	const root = await realpath(cwd);
	const scope = await realpath(resolve(cwd, path));
	assertWithin(root, scope);
	const info = await stat(scope);
	if (!info.isFile() && !info.isDirectory()) throw new Error("Explore scope must be a file or directory");
	return scope;
}

/** Keep native read/search behavior, checking canonical paths before each operation. */
export function createExploreTools(cwd: string, scope: string): AgentTool[] {
	return createReadOnlyTools(cwd, { grep: { ignoreConfig: true } }).map(
		(tool): AgentTool => ({
			...tool,
			async execute(id, args, signal, onUpdate) {
				signal?.throwIfAborted();
				const input = args as Record<string, unknown>;
				const requested = typeof input.path === "string" ? resolveToCwd(input.path, cwd) : scope;
				const canonical = await realpath(requested);
				assertWithin(scope, canonical);
				signal?.throwIfAborted();
				return tool.execute(id, { ...input, path: canonical }, signal, onUpdate);
			},
		}),
	);
}
