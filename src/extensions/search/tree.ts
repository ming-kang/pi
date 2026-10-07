import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export { DEFAULT_EXCLUDES } from "./excludes.ts";

/** ~server payload limit, minus envelope overhead */
export const MAX_TREE_BYTES = 250 * 1024;

export function gitignoreDirNames(realRoot: string): string[] {
	const names: string[] = [];
	for (const rel of [".gitignore", join(".git", "info", "exclude")]) {
		let text: string;
		try {
			text = readFileSync(join(realRoot, rel), "utf-8");
		} catch {
			continue;
		}
		for (const raw of text.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#") || line.startsWith("!")) continue;
			const p = line.replace(/^\/+/, "").replace(/\/+$/, "");
			if (!p || p.includes("/") || /[*?[\]]/.test(p)) continue;
			names.push(p);
		}
	}
	return names;
}

export interface TreeOptions {
	maxDepth?: number;
	exclude?: (name: string) => boolean;
}

export function renderTree(realRoot: string, label: string, opts: TreeOptions = {}): string {
	const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
	const exclude = opts.exclude ?? (() => false);
	const lines: string[] = [label];

	const walk = (dir: string, depth: number, prefix: string): void => {
		if (depth >= maxDepth) return;
		let names: string[];
		try {
			names = readdirSync(dir)
				.filter((n) => !exclude(n))
				.sort();
		} catch {
			return;
		}
		names.forEach((name, idx) => {
			const last = idx === names.length - 1;
			lines.push(prefix + (last ? "└── " : "├── ") + name);
			let isDir = false;
			try {
				isDir = statSync(join(dir, name)).isDirectory();
			} catch {}
			if (isDir) walk(join(dir, name), depth + 1, prefix + (last ? "    " : "│   "));
		});
	};

	walk(realRoot, 0, "");
	return lines.join("\n");
}
