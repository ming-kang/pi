/**
 * The local side of code_search: the planner runs remotely and names commands against a virtual
 * `/codebase`; this module executes them read-only, confined to one directory.
 *
 * Security boundary: every model-supplied path must resolve inside the root, both lexically and
 * after following symlinks, and must be a file or directory that `rg --files` lists, so ignored
 * files are neither searched, listed, nor read. Only `rg`, `readfile`, and `tree` exist; there is
 * no shell and no write. Model-supplied rg values only ever fill `--regexp` and `--glob`.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { ensureTool } from "../../utils/tools-manager.ts";

export const VIRTUAL_ROOT = "/codebase";

/** Per-command result cap. Results are sent back to Devin, whose request limit is ~320KB. */
const RESULT_MAX_LINES = 40;
const LINE_MAX_CHARS = 200;
/** Matches read from rg before it is stopped; enough to count which files an over-broad pattern hits. */
const RG_MAX_MATCHES = 2000;
/** The repo map's share of that limit; deeper trees fall back to shallower ones until they fit. */
const MAP_MAX_BYTES = 64 * 1024;
const MAP_MAX_DEPTH = 3;

/**
 * What every rg call sees: hidden files, and ignore files (`.gitignore`, `.ignore`, `.rgignore`)
 * even outside a git repository. `.git` itself is the one directory `--hidden` would otherwise add.
 */
const RG_SCOPE = ["--hidden", "--no-require-git", "--glob", "!.git/"];

interface Match {
	/** Relative to the root, with forward slashes. */
	path: string;
	line: number;
	text: string;
}

/** The files rg would search, and the directories that hold them. */
interface Index {
	/** Relative to the root, with forward slashes. */
	files: Set<string>;
	/** Directory ("" for the root) → its sorted entries, subdirectories with a trailing slash. */
	dirs: Map<string, string[]>;
}

/**
 * Run Pi's ripgrep in `root` on `target`, passing each output line to `onLine` until it returns
 * false. Planner globs in `args` come before `RG_SCOPE`, since rg lets a later glob win. Resolves
 * whether rg ran to the end.
 */
async function runRg(
	root: string,
	args: string[],
	target: string,
	onLine: (line: string) => boolean,
	signal?: AbortSignal,
): Promise<boolean> {
	const rg = await ensureTool("rg");
	if (!rg) throw new Error("ripgrep (rg) is not available");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(rg, [...args, ...RG_SCOPE, "--", target], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let lines = 0;
		let stopped = false;
		const stop = () => {
			stopped = true;
			child.kill();
		};
		signal?.addEventListener("abort", stop, { once: true });
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		createInterface({ input: child.stdout }).on("line", (line) => {
			if (stopped) return;
			lines++;
			if (!onLine(line)) stop();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", stop);
			if (signal?.aborted) return reject(new Error("Operation aborted"));
			// 1 is "no matches"; 2 with output means some files were unreadable, which is not worth failing over.
			if (!stopped && code !== 0 && code !== 1 && !lines) {
				// A regex error spans several lines: the message, the pattern, a caret, and the cause.
				const message = stderr.trim().split(/\r?\n/).slice(0, 6).join("\n");
				return reject(new Error(message || `rg exited with code ${code}`));
			}
			resolvePromise(!stopped);
		});
	});
}

/** An rg-reported path relative to the root, with forward slashes. */
function rgPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** A planner glob as rg takes it: relative to the root, which is where rg runs. */
function rgGlob(glob: string): string {
	return glob.replace(/\\/g, "/").replace(new RegExp(`^${VIRTUAL_ROOT}/`), "");
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

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function clip(line: string): string {
	return line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) : line;
}

function capLines(text: string): string {
	const lines = text.split("\n");
	const kept = lines.slice(0, RESULT_MAX_LINES).map(clip);
	if (lines.length > RESULT_MAX_LINES) kept.push(`... (${lines.length - RESULT_MAX_LINES} more lines)`);
	return kept.join("\n");
}

function virtualOf(rel: string): string {
	return rel ? `${VIRTUAL_ROOT}/${rel}` : VIRTUAL_ROOT;
}

export interface Command {
	type?: unknown;
	pattern?: unknown;
	path?: unknown;
	include?: unknown;
	exclude?: unknown;
	file?: unknown;
	start_line?: unknown;
	end_line?: unknown;
	levels?: unknown;
}

export class Workspace {
	readonly root: string;
	private index?: Promise<Index>;

	constructor(root: string) {
		this.root = resolve(root);
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
		} else if (isAbsolute(virtual) || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
			// A drive-letter path is another drive on Windows and a stray filename elsewhere; refuse it everywhere.
			return null;
		} else {
			rel = normalized;
		}
		const candidate = resolve(this.root, rel.replace(/^\/+/, ""));
		return this.contains(candidate) ? candidate : null;
	}

	toVirtual(real: string): string {
		return virtualOf(relative(this.root, real).split(sep).join("/"));
	}

	/** Every file rg would search, listed once per search; tree, readfile, and rg targets all check against it. */
	private files(signal?: AbortSignal): Promise<Index> {
		this.index ??= (async () => {
			const files = new Set<string>();
			await runRg(
				this.root,
				["--files"],
				".",
				(line) => {
					files.add(rgPath(line));
					return true;
				},
				signal,
			);
			const entries = new Map<string, Set<string>>([["", new Set()]]);
			for (const file of files) {
				const parts = file.split("/");
				for (let i = 0; i < parts.length; i++) {
					const dir = parts.slice(0, i).join("/");
					if (!entries.has(dir)) entries.set(dir, new Set());
					entries.get(dir)!.add(i < parts.length - 1 ? `${parts[i]}/` : parts[i]!);
				}
			}
			return { files, dirs: new Map([...entries].map(([dir, names]) => [dir, [...names].sort()])) };
		})();
		return this.index;
	}

	/** A model-named path that rg would see, or the error string to return in its place. */
	private async find(
		value: unknown,
		signal?: AbortSignal,
	): Promise<{ rel: string; real: string; kind: "file" | "dir" } | { error: string }> {
		const real = this.toReal(value);
		if (!real) return { error: `Error: path outside project root: ${String(value)}` };
		const rel = relative(this.root, real).split(sep).join("/");
		const index = await this.files(signal);
		if (index.files.has(rel)) return { rel, real, kind: "file" };
		if (index.dirs.has(rel)) return { rel, real, kind: "dir" };
		return {
			error: existsSync(real)
				? `Error: not searchable (ignored, inside .git, or an empty directory): ${String(value)}`
				: `Error: path does not exist: ${String(value)}`,
		};
	}

	/** The deepest tree of the root, up to three levels, that fits the map budget. */
	async repoMap(signal?: AbortSignal): Promise<{ depth: number; tree: string }> {
		const index = await this.files(signal);
		for (let depth = MAP_MAX_DEPTH; depth > 1; depth--) {
			const tree = renderTree(index, "", depth);
			if (Buffer.byteLength(tree) <= MAP_MAX_BYTES) return { depth, tree };
		}
		return { depth: 1, tree: renderTree(index, "", 1).slice(0, MAP_MAX_BYTES / 4) };
	}

	async run(command: Command, signal?: AbortSignal): Promise<string> {
		try {
			switch (command?.type) {
				case "rg":
					return await this.rg(command, signal);
				case "readfile":
					return await this.readfile(command, signal);
				case "tree":
					return await this.tree(command, signal);
				default:
					return `Error: unknown command type '${String(command?.type)}'; use rg, readfile, or tree`;
			}
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	private async rg(command: Command, signal?: AbortSignal): Promise<string> {
		if (typeof command.pattern !== "string" || !command.pattern) return "Error: missing pattern";
		// rg searches a path it is handed even when ignored, so the target must pass the same check as readfile.
		const target = await this.find(command.path ?? VIRTUAL_ROOT, signal);
		if ("error" in target) return target.error;
		const args = ["--null", "--line-number", "--with-filename", "--no-heading", "--color=never", "--smart-case"];
		args.push("--max-columns", String(LINE_MAX_CHARS), "--max-columns-preview");
		for (const glob of strings(command.include)) args.push("--glob", rgGlob(glob));
		for (const glob of strings(command.exclude)) args.push("--glob", `!${rgGlob(glob).replace(/^!+/, "")}`);
		args.push("--regexp", command.pattern);

		const matches: Match[] = [];
		const complete = await runRg(
			this.root,
			args,
			target.rel || ".",
			(line) => {
				const nul = line.indexOf("\0");
				const m = line.slice(nul + 1).match(/^(\d+):(.*)$/);
				if (nul >= 0 && m) {
					matches.push({ path: rgPath(line.slice(0, nul)), line: Number(m[1]), text: m[2]!.replace(/\r$/, "") });
				}
				return matches.length < RG_MAX_MATCHES;
			},
			signal,
		);
		if (!matches.length) return "(no matches)";
		matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
		const lines = matches.map((m) => `${VIRTUAL_ROOT}/${m.path}:${m.line}:${m.text}`);
		if (lines.length <= RESULT_MAX_LINES) return capLines(lines.join("\n"));
		return capLines([...matchSummary(matches, complete), ...lines].join("\n"));
	}

	/** A numbered slice of a text file, headed by its length and ending with where to continue. */
	private async readfile(command: Command, signal?: AbortSignal): Promise<string> {
		const file = await this.find(command.file, signal);
		if ("error" in file) return file.error;
		if (file.kind !== "file") return `Error: not a file: ${String(command.file)}`;
		const name = virtualOf(file.rel);
		const buffer = readFileSync(file.real);
		if (buffer.subarray(0, 8192).includes(0)) return `Error: binary file: ${name}`;
		const lines = buffer.toString("utf-8").split(/\r?\n/);
		if (lines.at(-1) === "") lines.pop();
		const total = lines.length;
		if (!total) return `${name} (empty)`;

		const start = Math.max(1, Number(command.start_line) || 1);
		const end = Math.min(total, Number(command.end_line) || total);
		if (start > total) return `Error: start_line ${start} is past the end of ${name} (${total} lines)`;
		if (end < start) return `Error: end_line ${end} is before start_line ${start}`;
		const last = Math.min(end, start + RESULT_MAX_LINES - 1);
		const out = [`${name} (${total} lines)`];
		for (let n = start; n <= last; n++) out.push(clip(`${n}:${lines[n - 1]}`));
		if (last < end) out.push(`... (lines ${last + 1}-${end} not shown; continue with start_line=${last + 1})`);
		return out.join("\n");
	}

	/** The requested depth of a directory, or the deepest one that fits the result cap. */
	private async tree(command: Command, signal?: AbortSignal): Promise<string> {
		const dir = await this.find(command.path ?? VIRTUAL_ROOT, signal);
		if ("error" in dir) return dir.error;
		if (dir.kind !== "dir") return `Error: not a directory: ${String(command.path)}`;
		const index = await this.files(signal);
		const levels = Math.min(Math.max(Number(command.levels) || 2, 1), 4);
		let depth = levels;
		let tree = renderTree(index, dir.rel, depth);
		while (depth > 1 && tree.split("\n").length > RESULT_MAX_LINES) tree = renderTree(index, dir.rel, --depth);
		return depth < levels ? `${capLines(tree)}\n(levels reduced to ${depth} to fit)` : capLines(tree);
	}
}

/**
 * What an over-broad pattern hit, per file, ahead of the first matches; rg's arbitrary first 40
 * lines would say nothing about where to narrow next.
 */
function matchSummary(matches: Match[], complete: boolean): string[] {
	const counts = new Map<string, number>();
	for (const m of matches) counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
	const total = complete ? `${matches.length} matches` : `More than ${RG_MAX_MATCHES} matches`;
	const files = complete ? `${counts.size} files` : `at least ${counts.size} files`;
	// Densest files first: they are where a narrower search most likely belongs.
	const rows = [...counts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, RESULT_MAX_LINES / 2)
		.map(([path, n]) => `${VIRTUAL_ROOT}/${path}: ${n}`);
	if (counts.size > rows.length) rows.push(`... (${counts.size - rows.length} more files)`);
	return [
		`${total} in ${files}; narrow with path, include, exclude, or a more specific pattern. Matches per file:`,
		...rows,
		"First matches:",
	];
}

/** `dir` and its entries to `maxDepth` levels; a trailing slash marks a directory. */
function renderTree(index: Index, dir: string, maxDepth: number): string {
	const lines = [virtualOf(dir)];
	const walk = (current: string, depth: number, prefix: string): void => {
		if (depth >= maxDepth) return;
		const entries = index.dirs.get(current) ?? [];
		entries.forEach((name, i) => {
			const last = i === entries.length - 1;
			lines.push(`${prefix}${last ? "└── " : "├── "}${name}`);
			if (name.endsWith("/")) {
				const child = current ? `${current}/${name.slice(0, -1)}` : name.slice(0, -1);
				walk(child, depth + 1, `${prefix}${last ? "    " : "│   "}`);
			}
		});
	};
	walk(dir, 0, "");
	return lines.join("\n");
}
