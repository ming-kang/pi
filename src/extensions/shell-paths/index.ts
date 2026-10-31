import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { normalizePath, normalizeWindowsShellPath } from "../../utils/paths.ts";
import { getShellConfig } from "../../utils/shell.ts";

/** Built-in tools whose `path` argument names a file or directory. */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
/** `<Windows path> on <mount point> type <fs> (<flags>)`, as printed by Git Bash, MSYS2, and Cygwin `mount`. */
const MOUNT_LINE = /^(.+?) on (\/.*) type \S+ \([^)]*\)$/;
const MOUNT_TIMEOUT_MS = 5000;

interface Mount {
	point: string;
	target: string;
}

function parseMounts(output: string): Mount[] {
	const mounts: Mount[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = MOUNT_LINE.exec(line.trim());
		// Native file tools reach only Windows directories, which also skips virtual mounts.
		if (!match || !/^[a-z]:(?:[\\/]|$)/i.test(match[1])) continue;
		const [, source, point] = match;
		mounts.push({ point, target: win32.normalize(source.length === 2 ? `${source}\\` : source) });
	}
	// The longest mount point wins, so /tmp is matched before /.
	return mounts.sort((a, b) => b.point.length - a.point.length);
}

function readMounts(shellPath: string | undefined): Promise<Mount[]> {
	return new Promise((resolve) => {
		try {
			const shell = getShellConfig(shellPath ? normalizePath(shellPath) : undefined);
			// Legacy WSL bash mounts live inside Linux; core already maps its /mnt/<drive> paths.
			if (shell.commandTransport === "stdin") return resolve([]);
			execFile(
				shell.shell,
				[...shell.args, "mount"],
				{ timeout: MOUNT_TIMEOUT_MS, windowsHide: true },
				(error, stdout) => resolve(error ? [] : parseMounts(stdout)),
			);
		} catch {
			resolve([]);
		}
	});
}

function toWindowsPath(path: string, mounts: readonly Mount[]): string | undefined {
	const normalized = posix.normalize(path);
	const mount = mounts.find(
		({ point }) => point === "/" || normalized === point || normalized.startsWith(`${point}/`),
	);
	return mount && win32.join(mount.target, posix.relative(mount.point, normalized));
}

/**
 * Bash on Windows reports paths under its own mount table (`/tmp`, `/usr`, ...), which native file
 * tools would otherwise resolve against the current drive root. Rewrite them to the Windows
 * directories bash means. Drive paths such as `/c/...` stay with core path normalization.
 */
export default function shellPathsExtension(pi: ExtensionAPI): void {
	if (process.platform !== "win32") return;
	const mountsByShellPath = new Map<string | undefined, Promise<Mount[]>>();

	function getMounts(): Promise<Mount[]> {
		const shellPath = pi.getSettings().shellPath;
		let mounts = mountsByShellPath.get(shellPath);
		if (!mounts) {
			mounts = readMounts(shellPath);
			mountsByShellPath.set(shellPath, mounts);
		}
		return mounts;
	}

	pi.on("tool_call", async (event) => {
		if (!PATH_TOOLS.has(event.toolName)) return;
		const input = event.input as { path?: unknown };
		const path = input.path;
		if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return;
		if (normalizeWindowsShellPath(path) !== path) return;
		const windowsPath = toWindowsPath(path, await getMounts());
		if (windowsPath) input.path = windowsPath;
	});
}
