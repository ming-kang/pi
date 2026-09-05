import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { machine, platform, release } from "node:os";
import type { FetchFunction, ProviderHeaders } from "@earendil-works/pi-ai";

export const CODEX_VERSION = "0.153.4";
export const CODEX_ORIGINATOR = "codex_cli_rs";

type Environment = Readonly<Record<string, string | undefined>>;

/** Environment-only Codex terminal detection. Deliberately does not query tmux clients or spawn zellij. */
export function getCodexTerminal(env: Environment): string {
	const nonEmpty = (key: string) => (env[key]?.trim() ? env[key] : undefined);
	const has = (key: string) => env[key] !== undefined;
	const versioned = (name: string, version?: string) => (version ? `${name}/${version}` : name);
	let token: string;
	const program = nonEmpty("TERM_PROGRAM");
	if (program) token = versioned(program, nonEmpty("TERM_PROGRAM_VERSION"));
	else if (has("WEZTERM_VERSION")) token = versioned("WezTerm", nonEmpty("WEZTERM_VERSION"));
	else if (["ITERM_SESSION_ID", "ITERM_PROFILE", "ITERM_PROFILE_NAME"].some(has)) token = "iTerm.app";
	else if (has("TERM_SESSION_ID")) token = "Apple_Terminal";
	else if (has("KITTY_WINDOW_ID") || env.TERM?.includes("kitty")) token = "kitty";
	else if (has("ALACRITTY_SOCKET") || env.TERM === "alacritty") token = "Alacritty";
	else if (has("KONSOLE_VERSION")) token = versioned("Konsole", nonEmpty("KONSOLE_VERSION"));
	else if (has("GNOME_TERMINAL_SCREEN")) token = "gnome-terminal";
	else if (has("VTE_VERSION")) token = versioned("VTE", nonEmpty("VTE_VERSION"));
	else if (has("WT_SESSION")) token = "WindowsTerminal";
	else token = nonEmpty("TERM") ?? "unknown";
	return Array.from(token, (char) => (/^[a-zA-Z0-9_./-]$/.test(char) ? char : "_")).join("");
}

/** Pure formatter; osType/version/architecture are os_info display values, not Node platform/arch identifiers. */
export function formatCodexUserAgent(
	osType: string,
	osVersion: string,
	architecture: string,
	env: Environment,
): string {
	return `${CODEX_ORIGINATOR}/${CODEX_VERSION} (${osType} ${osVersion}; ${architecture}) ${getCodexTerminal(env)}`.replace(
		/[^\x20-\x7e]/gu,
		"_",
	);
}

function commandOutput(command: string, args: string[]): string | undefined {
	try {
		return (
			execFileSync(command, args, {
				encoding: "utf8",
				timeout: 500,
				maxBuffer: 4096,
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

function getOsIdentity(): [string, string, string] {
	const host = platform();
	let architecture = machine();
	// os_info windows/winapi.rs uses GetNativeSystemInfo: x86_64, aarch64, i386 (not x64/arm64/x86).
	architecture =
		({ AMD64: "x86_64", x64: "x86_64", ARM64: "aarch64", arm64: "aarch64", x86: "i386" } as Record<string, string>)[
			architecture
		] ?? architecture;
	if (host === "win32") return ["Windows", release(), architecture];
	if (host === "darwin")
		return ["Mac OS", commandOutput("/usr/bin/sw_vers", ["-productVersion"]) ?? "Unknown", architecture];
	if (host === "linux") {
		try {
			const fields = new Map(
				readFileSync("/etc/os-release", "utf8")
					.split("\n")
					.map((line) => {
						const separator = line.indexOf("=");
						return [line.slice(0, separator), line.slice(separator + 1).replace(/^"|"$/g, "")];
					}),
			);
			// Common distributions only: os_info's full distro/lsb_release fallback matrix is not reproduced.
			const names: Record<string, string> = {
				ubuntu: "Ubuntu",
				debian: "Debian",
				fedora: "Fedora",
				arch: "Arch Linux",
				alpine: "Alpine Linux",
				linuxmint: "Linux Mint",
				nixos: "NixOS",
				centos: "CentOS",
				rocky: "Rocky Linux",
				rhel: "Red Hat Enterprise Linux",
			};
			return [names[fields.get("ID") ?? ""] ?? "Linux", fields.get("VERSION_ID") || "Unknown", architecture];
		} catch {
			return ["Linux", "Unknown", architecture];
		}
	}
	return [
		({ freebsd: "FreeBSD", openbsd: "OpenBSD", netbsd: "NetBSD", aix: "AIX" } as Record<string, string>)[host] ??
			"Unknown",
		release(),
		architecture,
	];
}

let userAgent: string | undefined;
export function getCodexUserAgent(): string {
	userAgent ??= formatCodexUserAgent(...getOsIdentity(), process.env);
	return userAgent;
}

const STAINLESS_HEADERS = [
	"x-stainless-lang",
	"x-stainless-package-version",
	"x-stainless-os",
	"x-stainless-arch",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
	"x-stainless-retry-count",
	"x-stainless-timeout",
	"x-stainless-helper-method",
	"x-stainless-async",
];

/** SDK defaults are nullable. Normalize names before merging so casing cannot resurrect a removed default. */
export function buildCodexHeaders(headers?: ProviderHeaders): ProviderHeaders {
	const result: ProviderHeaders = {
		"user-agent": getCodexUserAgent(),
		originator: CODEX_ORIGINATOR,
		accept: "text/event-stream",
		"content-type": "application/json",
		"x-session-affinity": null,
		"openai-organization": null,
		"openai-project": null,
	};
	// SDK process defaults belong to its OpenAI client, not to an unrelated configured relay.
	// Suppress their names without logging values; explicit provider/header hooks still win below.
	for (const line of (process.env.OPENAI_CUSTOM_HEADERS ?? "").split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) && !Object.hasOwn(result, name)) result[name] = null;
	}
	for (const key of STAINLESS_HEADERS) result[key] = null;
	for (const [key, value] of Object.entries(headers ?? {})) result[key.toLowerCase()] = value;
	// Lifecycle owns hyphenated session-id/thread-id; never emit Pi's underscore affinity header.
	result.session_id = null;
	return result;
}

/** Per-provider, post-SDK cleanup only; this does not emulate Codex's TLS/HTTP transport fingerprint. */
export function createCodexFetch(fetch: FetchFunction = globalThis.fetch.bind(globalThis)): FetchFunction {
	return async (input, init) => {
		// Fetch replaces (does not overlay) Request headers when init.headers is supplied.
		// Forward the original Request and all init options: body streams, duplex, signal and dispatcher stay intact.
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		const names: string[] = [];
		headers.forEach((_value, name) => {
			names.push(name);
		});
		for (const key of names) {
			if (
				key.startsWith("x-stainless-") ||
				key.startsWith("x-pi-") ||
				key === "x-session-affinity" ||
				key === "session_id"
			) {
				headers.delete(key);
			}
		}
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		// SDK's JSON Accept is wrong for normal Responses SSE. An absent Accept may be an explicit null;
		// do not resurrect it (nor UA/originator/content-type) after SDK nullable-header assembly.
		if (method === "POST" && /\/responses\/?$/.test(url.pathname) && headers.has("accept")) {
			headers.set("accept", "text/event-stream");
		}
		return fetch(input, { ...init, headers });
	};
}
