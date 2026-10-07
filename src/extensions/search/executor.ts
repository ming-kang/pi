import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PathSandbox } from "./sandbox.ts";
import { renderTree } from "./tree.ts";

/** Per-command caps: these results are the protocol payload sent back to Devin, so one noisy command cannot flood it. */
const RESULT_MAX_LINES = 50;
const LINE_MAX_CHARS = 250;
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${` characters are intentional
const GLOB_REGEX_META = ".+^${}()|\\";

export type GrepFn = (
	pattern: string,
	realPath: string,
	glob: string | undefined,
	signal?: AbortSignal,
) => Promise<string>;

export interface RestrictedCommand {
	type?: string;
	pattern?: string;
	path?: string;
	file?: string;
	include?: string[];
	exclude?: string[];
	start_line?: number;
	end_line?: number;
	levels?: number;
	long_format?: boolean;
	all?: boolean;
	type_filter?: string;
}

export class ToolExecutor {
	sandbox: PathSandbox;
	grepFn: GrepFn;
	collectedRgPatterns: string[] = [];

	constructor(sandbox: PathSandbox, grepFn: GrepFn) {
		this.sandbox = sandbox;
		this.grepFn = grepFn;
	}

	static truncate(text: string): string {
		const lines = text.split("\n");
		const out: string[] = [];
		const limit = Math.min(lines.length, RESULT_MAX_LINES);
		for (let i = 0; i < limit; i++) {
			const line = lines[i]!;
			out.push(line.length > LINE_MAX_CHARS ? line.slice(0, LINE_MAX_CHARS) : line);
		}
		let result = out.join("\n");
		if (lines.length > RESULT_MAX_LINES) result += "\n... (lines truncated) ...";
		return result;
	}

	async rg(
		pattern: string | undefined,
		path: string | undefined,
		include: string[] | null,
		signal?: AbortSignal,
	): Promise<string> {
		if (!pattern || typeof pattern !== "string") return "Error: missing or invalid pattern";
		if (!path || typeof path !== "string") return "Error: missing or invalid path";
		this.collectedRgPatterns.push(pattern);
		const real = this.sandbox.toReal(path);
		if (real === null) return `Error: path outside project root: ${path}`;
		if (!existsSync(real)) return `Error: path does not exist: ${path}`;
		let raw: string;
		try {
			raw = await this.grepFn(pattern, real, include?.[0], signal);
		} catch (e) {
			return `Error: ${(e as Error).message}`;
		}
		return ToolExecutor.truncate(this.remapGrepPaths(raw, real) || "(no matches)");
	}

	remapGrepPaths(text: string, realPath: string): string {
		const base = this.sandbox.toVirtual(realPath);
		let isFile = false;
		try {
			isFile = statSync(realPath).isFile();
		} catch {}
		return text
			.split("\n")
			.map((line) => {
				const m = line.match(/^(.+?):(\d+):(.*)$/);
				if (!m) return line;
				const path = isFile ? base : `${base}/${m[1]!.replace(/^[/\\]+/, "")}`;
				return `${path}:${m[2]}:${m[3]}`;
			})
			.join("\n");
	}

	readfile(file: string | undefined, startLine: number | null, endLine: number | null): string {
		if (!file || typeof file !== "string") return "Error: missing or invalid file path";
		const real = this.sandbox.toReal(file);
		if (real === null) return `Error: path outside project root: ${file}`;
		try {
			if (!statSync(real).isFile()) return `Error: file not found: ${file}`;
		} catch {
			return `Error: file not found: ${file}`;
		}
		let content: string;
		try {
			content = readFileSync(real, "utf-8");
		} catch (e) {
			return `Error: ${(e as Error).message}`;
		}
		const allLines = content.split("\n");
		const s = (startLine || 1) - 1;
		const e = endLine || allLines.length;
		const out = allLines
			.slice(s, e)
			.map((line, idx) => `${s + idx + 1}:${line}`)
			.join("\n");
		return ToolExecutor.truncate(out);
	}

	tree(path: string | undefined, levels: number | null): string {
		if (!path || typeof path !== "string") return "Error: missing or invalid path";
		const real = this.sandbox.toReal(path);
		if (real === null) return `Error: path outside project root: ${path}`;
		try {
			if (!statSync(real).isDirectory()) return `Error: dir not found: ${path}`;
		} catch {
			return `Error: dir not found: ${path}`;
		}
		const text = renderTree(real, this.sandbox.toVirtual(real), { maxDepth: levels || undefined });
		return ToolExecutor.truncate(text);
	}

	ls(path: string | undefined, longFormat: boolean, allFiles: boolean): string {
		if (!path || typeof path !== "string") return "Error: missing or invalid path";
		const real = this.sandbox.toReal(path);
		if (real === null) return `Error: path outside project root: ${path}`;
		try {
			if (!statSync(real).isDirectory()) return `Error: not a directory: ${path}`;
		} catch {
			return `Error: dir not found: ${path}`;
		}
		let entries: string[];
		try {
			entries = readdirSync(real).sort();
		} catch (e) {
			return `Error: ${(e as Error).message}`;
		}
		if (!allFiles) entries = entries.filter((e) => !e.startsWith("."));
		if (!longFormat) return ToolExecutor.truncate(entries.join("\n"));

		const lines = [`total ${entries.length}`];
		for (const name of entries) {
			try {
				const st = statSync(join(real, name));
				const type = st.isDirectory() ? "d" : "-";
				const size = String(st.size).padStart(8);
				const mtime = st.mtime;
				const month = mtime.toLocaleString("en", { month: "short" });
				const day = String(mtime.getDate()).padStart(2);
				const hh = String(mtime.getHours()).padStart(2, "0");
				const mm = String(mtime.getMinutes()).padStart(2, "0");
				lines.push(`${type}rwxr-xr-x  1 user  staff ${size} ${month} ${day} ${hh}:${mm} ${name}`);
			} catch {
				lines.push(`?---------  ? ?     ?        ? ? ?     ? ${name}`);
			}
		}
		return ToolExecutor.truncate(lines.join("\n"));
	}

	glob(pattern: string | undefined, path: string | undefined, typeFilter: string): string {
		if (!pattern || typeof pattern !== "string") return "Error: missing or invalid pattern";
		if (!path || typeof path !== "string") return "Error: missing or invalid path";
		const real = this.sandbox.toReal(path);
		if (real === null) return `Error: path outside project root: ${path}`;
		const matches: string[] = [];
		globWalk(real, pattern, matches, typeFilter, this.sandbox);
		const out = matches
			.sort()
			.slice(0, 100)
			.map((m) => this.sandbox.toVirtual(m))
			.join("\n");
		return out || "(no matches)";
	}

	async execCommand(cmd: RestrictedCommand, signal?: AbortSignal): Promise<string> {
		if (!cmd || typeof cmd !== "object") return "Error: missing or invalid command";
		switch (cmd.type) {
			case "rg":
				return this.rg(cmd.pattern, cmd.path, cmd.include ?? null, signal);
			case "readfile":
				return this.readfile(cmd.file, cmd.start_line ?? null, cmd.end_line ?? null);
			case "tree":
				return this.tree(cmd.path, cmd.levels ?? null);
			case "ls":
				return this.ls(cmd.path, cmd.long_format ?? false, cmd.all ?? false);
			case "glob":
				return this.glob(cmd.pattern, cmd.path, cmd.type_filter ?? "all");
			default:
				return `Error: unknown command type '${cmd.type ?? ""}'`;
		}
	}

	async execToolCall(args: Record<string, RestrictedCommand>, signal?: AbortSignal): Promise<string> {
		if (!args || typeof args !== "object") return "Error: missing or invalid tool args";
		const keys = Object.keys(args)
			.filter((k) => k.startsWith("command"))
			.sort();
		const results = await Promise.all(
			keys.map(async (key) => `<${key}_result>\n${await this.execCommand(args[key]!, signal)}\n</${key}_result>`),
		);
		return results.join("");
	}
}

function fnmatch(str: string, pattern: string): boolean {
	let regex = "^";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i]!;
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				regex += ".*";
				i += 2;
				if (pattern[i] === "/") i++;
				continue;
			}
			regex += "[^/]*";
		} else if (c === "?") {
			regex += "[^/]";
		} else if (c === "[") {
			const end = pattern.indexOf("]", i);
			if (end === -1) {
				regex += "\\[";
			} else {
				regex += pattern.slice(i, end + 1);
				i = end;
			}
		} else if (GLOB_REGEX_META.includes(c)) {
			regex += `\\${c}`;
		} else {
			regex += c;
		}
		i++;
	}
	regex += "$";
	try {
		return new RegExp(regex).test(str);
	} catch {
		return false;
	}
}

function globWalk(base: string, pattern: string, matches: string[], typeFilter: string, sandbox: PathSandbox): void {
	const isRecursive = pattern.includes("**");

	const walk = (dir: string, depth: number): void => {
		if (matches.length >= 100) return;
		if (!isRecursive && depth > 0) return;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (matches.length >= 100) return;
			const fp = join(dir, entry);
			if (!sandbox.contains(fp)) continue; // refuse symlink escapes
			const relFromBase = relative(base, fp).replace(/\\/g, "/");

			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(fp);
			} catch {
				continue;
			}

			if (fnmatch(relFromBase, pattern) || fnmatch(entry, pattern)) {
				const ok = typeFilter === "file" ? st.isFile() : typeFilter === "directory" ? st.isDirectory() : true;
				if (ok) matches.push(fp);
			}

			if (st.isDirectory() && !entry.startsWith(".") && isRecursive) walk(fp, depth + 1);
		}
	};

	walk(base, 0);
}
