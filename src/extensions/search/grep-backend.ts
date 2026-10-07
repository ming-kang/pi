/** The one seam that touches Pi's own tooling: the rg restricted command is served
 * by Pi's built-in grep tool (gitignore-aware, ships its own ripgrep) instead of
 * bundling @vscode/ripgrep. Tradeoff: Pi's grep takes a single glob, so the
 * upstream multi-glob include/exclude collapses to the first include. */
import { createGrepToolDefinition } from "../../core/tools/grep.ts";
import type { GrepFn } from "./executor.ts";

interface GrepResult {
	content?: Array<{ type?: string; text?: string }>;
}

export function createPiGrepFn(realRoot: string): GrepFn {
	const grep = createGrepToolDefinition(realRoot);
	// The distro's execute() takes five positional args; this seam only ever passes
	const run = grep.execute as unknown as (
		toolCallId: string,
		params: { pattern: string; path: string; glob?: string; limit: number },
		signal?: AbortSignal,
	) => Promise<GrepResult>;
	return async (pattern, realPath, glob, signal) => {
		const res = await run("fc-rg", { pattern, path: realPath, glob, limit: 50 }, signal);
		const block = (res.content ?? []).find((c) => c?.type === "text");
		return block?.text ?? "";
	};
}
