/**
 * The local side of code_search: the planner runs remotely and names commands against a virtual
 * `/codebase`; this module executes them read-only, confined to one directory.
 *
 * Security boundary: every model-supplied path must resolve inside the root, both lexically and
 * after following symlinks. Only `rg`, `readfile`, and `tree` exist; there is no shell and no write.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGrepToolDefinition } from "../../core/tools/grep.ts";

export const VIRTUAL_ROOT = "/codebase";

/** Per-command result cap. Results are sent back to Devin, whose request limit is ~320KB. */
const RESULT_MAX_LINES = 40;
const LINE_MAX_CHARS = 200;
/** The repo map's share of that limit; deeper trees fall back to shallower ones until they fit. */
const MAP_MAX_BYTES = 64 * 1024;
const MAP_MAX_DEPTH = 3;

const NOISE_DIRS = [
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".next",
	".nuxt",
	".turbo",
	".idea",
	"vendor",
	"third_party",
];

/** `rg` backend: pattern, directory or file, optional glob → `path:line: text` lines. */
export type Grep = (pattern: string, path: string, glob: string | undefined, signal?: AbortSignal) => Promise<string>;

/** Pi's own grep tool: gitignore-aware, with its bundled ripgrep. It takes one glob, so only the first include applies. */
export function piGrep(root: string): Grep {
	const tool = createGrepToolDefinition(root);
	const execute = tool.execute as unknown as (
		id: string,
		params: { pattern: string; path: string; glob?: string; limit: number },
		signal?: AbortSignal,
	) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
	return async (pattern, path, glob, signal) => {
		const result = await execute("code_search", { pattern, path, glob, limit: RESULT_MAX_LINES }, signal);
		return result.content?.find((c) => c.type === "text")?.text ?? "";
	};
}

function within(base: string, path: string): boolean {
	const rel = relative(base, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** realpath of the longest existing prefix, so a not-yet-existing path still resolves through symlinks. */
function realpathOf(path: string): string {
	let current = resolve(path);
	const tail: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(path);
		tail.unshift(basename(current));
		current = parent;
	}
	try {
		return resolve(realpathSync(current), ...tail);
	} catch {
		return resolve(path);
	}
}

/** Whether `path` lies inside `root`, both as written and after following symlinks. */
export function isInside(root: string, path: string): boolean {
	const abs = resolve(path);
	return within(resolve(root), abs) && within(realpathOf(root), realpathOf(abs));
}

function capLines(text: string): string {
	const lines = text.split("\n");
	const kept = lines
		.slice(0, RESULT_MAX_LINES)
		.map((l) => (l.length > LINE_MAX_CHARS ? l.slice(0, LINE_MAX_CHARS) : l));
	if (lines.length > RESULT_MAX_LINES) kept.push(`... (${lines.length - RESULT_MAX_LINES} more lines)`);
	return kept.join("\n");
}

export interface Command {
	type?: unknown;
	pattern?: unknown;
	path?: unknown;
	include?: unknown;
	file?: unknown;
	start_line?: unknown;
	end_line?: unknown;
	levels?: unknown;
}

export class Workspace {
	readonly root: string;
	private readonly grep: Grep;
	private readonly noise: Set<string>;

	constructor(root: string, grep: Grep = piGrep(root)) {
		this.root = resolve(root);
		this.grep = grep;
		this.noise = new Set([...NOISE_DIRS, ...gitignoredNames(this.root)]);
	}

	contains(path: string): boolean {
		return isInside(this.root, path);
	}

	/** `/codebase/src/a.ts` or `src/a.ts` → an absolute path inside the root, or null. */
	toReal(virtual: unknown): string | null {
		if (typeof virtual !== "string" || !virtual) return null;
		const normalized = virtual.replace(/\\/g, "/");
		let rel: string;
		if (normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
			rel = normalized.slice(VIRTUAL_ROOT.length);
		} else if (isAbsolute(virtual) || normalized.startsWith("/")) {
			return null;
		} else {
			rel = normalized;
		}
		const candidate = resolve(this.root, rel.replace(/^\/+/, ""));
		return this.contains(candidate) ? candidate : null;
	}

	toVirtual(real: string): string {
		const rel = relative(this.root, real).split(sep).join("/");
		return rel ? `${VIRTUAL_ROOT}/${rel}` : VIRTUAL_ROOT;
	}

	/** The deepest tree of the root, up to three levels, that fits the map budget. */
	repoMap(): { depth: number; tree: string } {
		for (let depth = MAP_MAX_DEPTH; depth > 1; depth--) {
			const tree = this.renderTree(this.root, depth);
			if (Buffer.byteLength(tree) <= MAP_MAX_BYTES) return { depth, tree };
		}
		return { depth: 1, tree: this.renderTree(this.root, 1).slice(0, MAP_MAX_BYTES / 4) };
	}

	async run(command: Command, signal?: AbortSignal): Promise<string> {
		switch (command?.type) {
			case "rg":
				return this.rg(command, signal);
			case "readfile":
				return this.readfile(command);
			case "tree":
				return this.tree(command);
			default:
				return `Error: unknown command type '${String(command?.type)}'; use rg, readfile, or tree`;
		}
	}

	private async rg(command: Command, signal?: AbortSignal): Promise<string> {
		if (typeof command.pattern !== "string" || !command.pattern) return "Error: missing pattern";
		const real = this.toReal(command.path ?? VIRTUAL_ROOT);
		if (!real) return `Error: path outside project root: ${String(command.path)}`;
		if (!existsSync(real)) return `Error: path does not exist: ${String(command.path)}`;
		const include =
			Array.isArray(command.include) && typeof command.include[0] === "string" ? command.include[0] : undefined;
		let raw: string;
		try {
			raw = await this.grep(command.pattern, real, include, signal);
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
		// Pi's grep prints paths relative to the searched directory, or the bare file name for a file.
		const isFile = statSync(real).isFile();
		const base = this.toVirtual(real);
		const remapped = raw
			.split("\n")
			.map((line) => {
				const m = line.match(/^(.+?):(\d+):(.*)$/);
				if (!m) return line;
				return `${isFile ? base : `${base}/${m[1]!.replace(/\\/g, "/")}`}:${m[2]}:${m[3]}`;
			})
			.join("\n");
		return capLines(remapped.trim() || "(no matches)");
	}

	private readfile(command: Command): string {
		const real = this.toReal(command.file);
		if (!real) return `Error: path outside project root: ${String(command.file)}`;
		let content: string;
		try {
			if (!statSync(real).isFile()) return `Error: not a file: ${String(command.file)}`;
			content = readFileSync(real, "utf-8");
		} catch {
			return `Error: file not found: ${String(command.file)}`;
		}
		const lines = content.split("\n");
		const start = Math.max(1, Number(command.start_line) || 1);
		const end = Math.min(lines.length, Number(command.end_line) || lines.length);
		return capLines(
			lines
				.slice(start - 1, end)
				.map((line, i) => `${start + i}:${line}`)
				.join("\n"),
		);
	}

	private tree(command: Command): string {
		const real = this.toReal(command.path ?? VIRTUAL_ROOT);
		if (!real) return `Error: path outside project root: ${String(command.path)}`;
		try {
			if (!statSync(real).isDirectory()) return `Error: not a directory: ${String(command.path)}`;
		} catch {
			return `Error: directory not found: ${String(command.path)}`;
		}
		const levels = Math.min(Math.max(Number(command.levels) || 2, 1), 4);
		return capLines(this.renderTree(real, levels));
	}

	private renderTree(dir: string, maxDepth: number): string {
		const lines = [this.toVirtual(dir)];
		const walk = (current: string, depth: number, prefix: string): void => {
			if (depth >= maxDepth) return;
			let entries: string[];
			try {
				entries = readdirSync(current)
					.filter((name) => !this.noise.has(name))
					.sort();
			} catch {
				return;
			}
			entries.forEach((name, i) => {
				const last = i === entries.length - 1;
				lines.push(`${prefix}${last ? "└── " : "├── "}${name}`);
				const path = join(current, name);
				let isDir = false;
				try {
					isDir = statSync(path).isDirectory() && this.contains(path);
				} catch {}
				if (isDir) walk(path, depth + 1, `${prefix}${last ? "    " : "│   "}`);
			});
		};
		walk(dir, 0, "");
		return lines.join("\n");
	}
}

/** Plain directory names from `.gitignore`; patterns with slashes or globs are left to grep. */
function gitignoredNames(root: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(root, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
		.filter((name) => name && !name.startsWith("#") && !name.startsWith("!") && !/[/*?[\]]/.test(name));
}
