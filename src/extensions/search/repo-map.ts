import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ProbeFn, scoreDirectories } from "./directory-scorer.ts";
import { DEFAULT_EXCLUDES, gitignoreDirNames, MAX_TREE_BYTES, renderTree } from "./tree.ts";

export interface HotspotConfig {
	baseDepth: number;
	topK: number;
	hotspotDepth: number;
	maxBytes: number;
}

export interface RepoMapOptions {
	mode: "classic" | "hotspot";
	query: string;
	treeDepth: number;
	excludePaths: string[];
	probeFn?: ProbeFn;
	hotspot: HotspotConfig;
	signal?: AbortSignal;
}

export interface RepoMap {
	tree: string;
	depth: number;
	hotspotDepth?: number;
	sizeBytes: number;
	fellBack: boolean;
	strategy: "classic" | "hotspot";
	hotDirs: string[];
}

function buildExclude(realRoot: string, excludePaths: string[]): (name: string) => boolean {
	const set = new Set([...DEFAULT_EXCLUDES, ...gitignoreDirNames(realRoot), ...excludePaths]);
	return (name) => set.has(name);
}

function suggestDepth(realRoot: string): number {
	let count = 0;
	try {
		count = readdirSync(realRoot).length;
	} catch {}
	if (count < 500) return 4;
	if (count <= 5000) return 3;
	return 2;
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

function buildClassic(
	realRoot: string,
	label: string,
	opts: RepoMapOptions,
	exclude: (name: string) => boolean,
): RepoMap {
	const target = opts.treeDepth === 0 ? suggestDepth(realRoot) : opts.treeDepth;
	const { tree, depth, fellBack } = renderBudgeted(realRoot, label, target, exclude);
	return { tree, depth, sizeBytes: Buffer.byteLength(tree, "utf-8"), fellBack, strategy: "classic", hotDirs: [] };
}

async function buildHotspot(
	realRoot: string,
	label: string,
	opts: RepoMapOptions,
	exclude: (name: string) => boolean,
): Promise<RepoMap> {
	const cfg = opts.hotspot;
	const base = renderBudgeted(realRoot, label, cfg.baseDepth, exclude);
	const topDirs = listTopLevelDirs(realRoot, exclude);

	if (topDirs.length === 0) {
		return {
			tree: base.tree,
			depth: base.depth,
			sizeBytes: Buffer.byteLength(base.tree, "utf-8"),
			fellBack: base.fellBack,
			strategy: "hotspot",
			hotDirs: [],
		};
	}

	const hotspotDepth = opts.treeDepth > cfg.hotspotDepth ? Math.min(4, opts.treeDepth) : cfg.hotspotDepth;

	let hotDirs: string[] = [];
	let pathSpines: string[] = [];
	try {
		const scored = await scoreDirectories(
			opts.query,
			realRoot,
			topDirs,
			[...gitignoreDirNames(realRoot), ...opts.excludePaths],
			{
				topK: cfg.topK,
				probeFn: opts.probeFn,
				minReturn: 2,
				signal: opts.signal,
			},
		);
		hotDirs = scored.hotDirs;
		pathSpines = scored.pathSpines;
	} catch {
		return {
			tree: base.tree,
			depth: base.depth,
			sizeBytes: Buffer.byteLength(base.tree, "utf-8"),
			fellBack: base.fellBack,
			strategy: "hotspot",
			hotDirs: [],
		};
	}

	const hotspotEntries = hotDirs.map((dir) => ({
		dir,
		tree: renderTree(join(realRoot, dir), `${label}/${dir}`, { maxDepth: hotspotDepth, exclude }),
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

	if (sizeBytes > cfg.maxBytes) {
		if (spineSection) {
			tree = assemble(kept, "");
			sizeBytes = Buffer.byteLength(tree, "utf-8");
		}
		while (sizeBytes > cfg.maxBytes && kept.length > 0) {
			kept.pop();
			tree = assemble(kept, "");
			sizeBytes = Buffer.byteLength(tree, "utf-8");
		}
	}

	return {
		tree,
		depth: base.depth,
		hotspotDepth,
		sizeBytes,
		fellBack: base.fellBack,
		strategy: "hotspot",
		hotDirs: kept.map((h) => h.dir),
	};
}

export async function buildRepoMap(realRoot: string, label: string, opts: RepoMapOptions): Promise<RepoMap> {
	const exclude = buildExclude(realRoot, opts.excludePaths);
	if (opts.mode === "classic") return buildClassic(realRoot, label, opts, exclude);
	return buildHotspot(realRoot, label, opts, exclude);
}
