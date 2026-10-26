import { getShellConfig } from "../../utils/shell.ts";
import { type BashOperations, createLocalShellOperations } from "./bash.ts";

/**
 * Rewrite Windows CMD-style `nul` redirects to POSIX `/dev/null`.
 *
 * Models occasionally emit CMD syntax such as `command 2>nul` even though the
 * shell resolved by `getShellConfig` is always POSIX. A POSIX shell treats
 * `nul` as an ordinary file name, so the redirect creates a literal `nul`
 * file. On Windows that name is a reserved device name: Explorer and most
 * tools cannot delete the file, and it breaks `git add .` and `git clone`
 * for the affected directory.
 *
 * Matches `>nul`, `> NUL`, `2>nul`, `&>nul`, and `>>nul` case-insensitively
 * while leaving longer tokens such as `>null` or `>nul.txt` untouched. The
 * regex does not parse shell quoting, so a quoted literal such as
 * `echo "2>nul crashes"` is also rewritten when `nul` is followed by
 * whitespace; that is accepted because the pattern is rare and the rewritten
 * string stays harmless.
 */
const CMD_NUL_REDIRECT_REGEX = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

export function rewriteCmdNulRedirects(command: string): string {
	return command.replace(CMD_NUL_REDIRECT_REGEX, "$1/dev/null");
}

export function normalizeLocalBashCommand(command: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? rewriteCmdNulRedirects(command) : command;
}

/**
 * Local bash operations for every bash entry point: the managed shell tool,
 * extension `user_bash` handlers, and SDK callers. The process loop stays
 * upstream; only the command normalization is distribution-owned.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	const operations = createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
	return {
		exec: (command, cwd, execOptions) => operations.exec(normalizeLocalBashCommand(command), cwd, execOptions),
	};
}
