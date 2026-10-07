import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ProbeFn, scoreDirectories } from "./directory-scorer.ts";
import { DEFAULT_EXCLUDES, gitignoreDirNames, MAX_TREE_BYTES, renderTree } from "./tree.ts";

/** Ranked subtrees: how many hot directories to expand, how deep, and the byte budget they share. */
const HOTSPOT_TOP_K = 4;
const HOTSPOT_DEPTH = 2;
const HOTSPOT_MAX_BYTES = 120 * 1024;

export interface RepoMapOptions {
	query: string;
	/** Skeleton depth of the base tree; `renderBudgeted` walks it down until the tree fits its budget. */
	treeDepth: number;
	excludePaths: string[];
	probeFn?: ProbeFn;
	signal?: AbortSignal;
}

export interface RepoMap {
	tree: string;
	depth: number;
	hotspotDepth?: number;
	sizeBytes: number;
	fellBack: boolean;
	hotDirs: string[];
}

function buildExclude(realRoot: string, excludePaths: string[]): (name: string) => boolean {
	const set = new Set([...DEFAULT_EXCLUDES, ...gitignoreDirNames(realRoot), ...excludePaths]);
	return (name) => set.has(name);
}

function renderBudgeted(
	realRoot: string,
	label: string,
	targetDepth: number,
	exclude: (name: string) => boolean,
): { tree: string; depth: number; fellBack: boolean } {
	for (let depth = targetDepth; depth >= 1; depth--) {
		const tree = renderTree(realRoot, label, { maxDepth: depth, exclude });
		if (Buffer.byteLength(tree, "utf-8") <= MAX_TREE_BYTES) {
			return { tree, depth, fellBack: depth < targetDepth };
		}
	}
	const tree = renderTree(realRoot, label, { maxDepth: 1, exclude });
	return { tree, depth: 1, fellBack: true };
}

function listTopLevelDirs(realRoot: string, exclude: (name: string) => boolean): string[] {
	let entries: string[];
	try {
		entries = readdirSync(realRoot).sort();
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const name of entries) {
		if (exclude(name)) continue;
		try {
			if (statSync(join(realRoot, name)).isDirectory()) dirs.push(name);
		} catch {}
	}
	return dirs;
}

/**
 * A whole-repo skeleton plus the subtrees a query points at: the planner gets the global shape
 * cheaply, and the deepest detail where the query looks. The skeleton depth `tree_depth` asks for
 * is walked down until the tree fits, which the caller reports as `fellBack`.
 */
export async function buildRepoMap(realRoot: string, label: string, opts: RepoMapOptions): Promise<RepoMap> {
	const exclude = buildExclude(realRoot, opts.excludePaths);
	const base = renderBudgeted(realRoot, label, opts.treeDepth, exclude);
	const baseOnly: RepoMap = {
		tree: base.tree,
		depth: base.depth,
		sizeBytes: Buffer.byteLength(base.tree, "utf-8"),
		fellBack: base.fellBack,
		hotDirs: [],
	};

	const topDirs = listTopLevelDirs(realRoot, exclude);
	if (topDirs.length === 0) return baseOnly;

	let hotDirs: string[] = [];
	let pathSpines: string[] = [];
	try {
		const scored = await scoreDirectories(
			opts.query,
			realRoot,
			topDirs,
			[...gitignoreDirNames(realRoot), ...opts.excludePaths],
			{
				topK: HOTSPOT_TOP_K,
				probeFn: opts.probeFn,
				minReturn: 2,
				signal: opts.signal,
			},
		);
		hotDirs = scored.hotDirs;
		pathSpines = scored.pathSpines;
	} catch {
		return baseOnly;
	}

	const hotspotEntries = hotDirs.map((dir) => ({
		dir,
		tree: renderTree(join(realRoot, dir), `${label}/${dir}`, { maxDepth: HOTSPOT_DEPTH, exclude }),
	}));
	const spineSection = pathSpines.length
		? `# Relevant File Paths (high-signal candidates)\n${pathSpines.map((p) => `- ${label}/${p.replace(/\\/g, "/")}`).join("\n")}`
		: "";

	const assemble = (subtrees: Array<{ dir: string; tree: string }>, spine: string): string => {
		const sections: string[] = [];
		if (subtrees.length) sections.push(`# Hotspot Subtrees\n${subtrees.map((s) => s.tree).join("\n\n")}`);
		if (spine) sections.push(spine);
		return sections.length ? `${base.tree}\n\n${sections.join("\n\n")}` : base.tree;
	};

	const kept = [...hotspotEntries];
	let tree = assemble(kept, spineSection);
	let sizeBytes = Buffer.byteLength(tree, "utf-8");

	if (sizeBytes > HOTSPOT_MAX_BYTES) {
		if (spineSection) {
			tree = assemble(kept, "");
			sizeBytes = Buffer.byteLength(tree, "utf-8");
		}
		while (sizeBytes > HOTSPOT_MAX_BYTES && kept.length > 0) {
			kept.pop();
			tree = assemble(kept, "");
			sizeBytes = Buffer.byteLength(tree, "utf-8");
		}
	}

	return {
		tree,
		depth: base.depth,
		hotspotDepth: HOTSPOT_DEPTH,
		sizeBytes,
		fellBack: base.fellBack,
		hotDirs: kept.map((h) => h.dir),
	};
}
