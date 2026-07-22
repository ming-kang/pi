import path from "node:path";

export function editWriteTargetPath(input: unknown): string | undefined {
	const rawPath = (input as { path?: unknown } | undefined)?.path;
	return typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined;
}

export function resolveToolPath(rawPath: string, cwd: string): string {
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}
