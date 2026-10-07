/** Security boundary: the Devin backend plans filesystem commands that execute
 * locally, so every model-supplied path must prove containment inside the root. */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The path the backend believes it is working in; every model-supplied path is written in these terms. */
export const VIRTUAL_ROOT = "/codebase";

function within(base: string, p: string): boolean {
	const rel = relative(base, p);
	if (rel === "") return true;
	if (rel === "..") return false;
	if (rel.startsWith(`..${sep}`)) return false;
	if (isAbsolute(rel)) return false; // relative() is absolute across drives on Windows
	return true;
}

function safeRealpath(p: string): string {
	let current = resolve(p);
	const tail: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(p);
		tail.unshift(basename(current));
		current = parent;
	}
	try {
		const real = realpathSync(current);
		return tail.length ? resolve(real, ...tail) : real;
	} catch {
		return resolve(p);
	}
}

export class PathSandbox {
	readonly root: string;
	readonly realRoot: string;

	constructor(root: string) {
		this.root = resolve(root);
		this.realRoot = safeRealpath(this.root);
	}

	toReal(virtual: string): string | null {
		if (typeof virtual !== "string" || virtual.length === 0) return null;

		let rel: string;
		if (virtual.startsWith(VIRTUAL_ROOT) || virtual.startsWith("\\codebase")) {
			rel = virtual.slice(VIRTUAL_ROOT.length).replace(/^[/\\]+/, "");
		} else if (isAbsolute(virtual)) {
			return null; // absolute paths are refused: the model must address /codebase
		} else {
			rel = virtual.replace(/^[/\\]+/, "");
		}

		const candidate = resolve(this.root, rel);
		if (!this.contains(candidate)) return null;
		return candidate;
	}

	contains(realPath: string): boolean {
		const abs = resolve(realPath);
		return within(this.root, abs) && within(this.realRoot, safeRealpath(abs));
	}

	toVirtual(realPath: string): string {
		let out = realPath;
		for (const base of [this.realRoot, this.root]) {
			if (out === base) return VIRTUAL_ROOT;
			if (out.startsWith(base + sep)) {
				out = VIRTUAL_ROOT + out.slice(base.length);
				break;
			}
		}
		return out.split(sep).join("/");
	}

	remapText(text: string): string {
		let out = text;
		for (const base of new Set([this.realRoot, this.root])) {
			out = out.split(base).join(VIRTUAL_ROOT);
		}
		return out;
	}
}
