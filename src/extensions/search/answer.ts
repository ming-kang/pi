/** Parsing of the backend's final `<ANSWER>` payload into sandbox-verified file ranges. */
import type { PathSandbox } from "./sandbox.ts";
import { VIRTUAL_ROOT } from "./sandbox.ts";
import type { SearchFile } from "./types.ts";

const FILE_RE = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
const RANGE_RE = /<range>(\d+)-(\d+)<\/range>/g;

/** `/codebase/src/a.ts` -> `src/a.ts`. */
function toRelative(virtualPath: string): string {
	const rest = virtualPath.startsWith(VIRTUAL_ROOT) ? virtualPath.slice(VIRTUAL_ROOT.length) : virtualPath;
	return rest.replace(/^[/\\]+/, "");
}

/**
 * Extract the files the backend nominated. Every path is re-checked against the sandbox, so an
 * answer that names a path outside the project is dropped rather than handed back as a candidate.
 */
export function parseAnswer(xmlText: string, sandbox: PathSandbox): SearchFile[] {
	const files: SearchFile[] = [];
	for (const [, , virtualPath, body] of xmlText.matchAll(FILE_RE)) {
		const fullPath = sandbox.toReal(virtualPath!);
		if (fullPath === null) continue;
		files.push({
			path: toRelative(virtualPath!),
			fullPath,
			ranges: [...body!.matchAll(RANGE_RE)].map(([, start, end]): [number, number] => [
				Number.parseInt(start!, 10),
				Number.parseInt(end!, 10),
			]),
		});
	}
	return files;
}
