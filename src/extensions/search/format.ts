/** Model-facing rendering of a finished search: the file reading list, its keywords, and the config line. */
import type { SearchMeta, SearchResult } from "./types.ts";

const RAW_RESPONSE_MAX_CHARS = 2000;

export interface FormatOptions {
	maxTurns: number;
	maxResults: number;
	maxCommands: number;
	timeoutMs: number;
	excludePaths: string[];
}

function truncateText(text: string, maxLength: number): string {
	const ellipsis = "...";
	if (text.length <= maxLength) return text;
	if (ellipsis.length >= maxLength) return ellipsis.slice(0, maxLength);
	return `${text.slice(0, maxLength - ellipsis.length)}${ellipsis}`;
}

function hintFor(code?: string): string {
	if (code === "PAYLOAD_TOO_LARGE" || code === "TIMEOUT")
		return "\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.";
	if (code === "AUTH_ERROR")
		return "\n[hint] Devin authentication failed; re-authenticate with /search-login or set a new key with /search-key.";
	if (code === "RATE_LIMITED") return "\n[hint] Rate limited. Wait a moment and retry.";
	return "\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.";
}

/** `, strategy=hotspot, hotspot_depth=2, hot=[src]` — empty unless the repo map ran in hotspot mode. */
function strategySuffix(meta: SearchMeta): string {
	if (!meta.strategy) return "";
	const depth = meta.hotspotDepth ? `, hotspot_depth=${meta.hotspotDepth}` : "";
	const hot = meta.hotDirs?.length ? `, hot=[${meta.hotDirs.join(", ")}]` : "";
	return `, strategy=${meta.strategy}${depth}${hot}`;
}

function excludeSuffix(fmt: FormatOptions): string {
	return fmt.excludePaths.length ? `, exclude_paths=[${fmt.excludePaths.join(", ")}]` : "";
}

function formatError(result: SearchResult, fmt: FormatOptions): string {
	const meta = result.meta;
	if (!meta) return `Error: ${result.error}`;
	let out = `Error: ${result.error}`;
	out += `\n\n[diagnostic] error_type=${meta.errorCode ?? "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
	if (meta.fellBack) out += " (auto fell back from requested depth)";
	if (meta.contextTrimmed) out += ", context_trimmed=true";
	out += `\n[config] max_turns=${fmt.maxTurns}, max_results=${fmt.maxResults}, max_commands=${fmt.maxCommands}, timeout_ms=${fmt.timeoutMs}`;
	out += strategySuffix(meta);
	out += excludeSuffix(fmt);
	out += hintFor(meta.errorCode);
	return out;
}

export function formatSearchResult(result: SearchResult, fmt: FormatOptions): string {
	if (result.error) return formatError(result, fmt);

	const files = result.files ?? [];
	const rgPatterns = [...new Set(result.rgPatterns ?? [])].filter((p) => p.length >= 3);

	if (!files.length && !rgPatterns.length) {
		const rawFull = result.rawResponse ?? "";
		if (!rawFull) return "No relevant files found.";
		const raw =
			rawFull.length > RAW_RESPONSE_MAX_CHARS
				? `${truncateText(rawFull, RAW_RESPONSE_MAX_CHARS)}\n[raw response truncated: ${rawFull.length} chars total]`
				: rawFull;
		return `No relevant files found.\n\nRaw response:\n${raw}`;
	}

	const parts: string[] = [];
	const n = files.length;
	if (n) {
		parts.push(`Found ${n} relevant ${n === 1 ? "file" : "files"}.`, "");
		files.forEach((entry, i) => {
			const rangesStr = entry.ranges.map(([s, e]) => `L${s}-${e}`).join(", ");
			parts.push(`  [${i + 1}/${n}] ${entry.fullPath}${rangesStr ? ` (${rangesStr})` : ""}`);
		});
	} else {
		parts.push("No files found.");
	}

	if (rgPatterns.length) parts.push("", `grep keywords: ${rgPatterns.join(", ")}`);

	const meta = result.meta;
	if (meta) {
		const fellBack = meta.fellBack ? " (fell back from requested depth)" : "";
		parts.push(
			"",
			`[config] tree_depth=${meta.treeDepth}${fellBack}, tree_size=${meta.treeSizeKB}KB${strategySuffix(meta)}, max_turns=${fmt.maxTurns}, max_results=${fmt.maxResults}, timeout_ms=${fmt.timeoutMs}${excludeSuffix(fmt)}`,
		);
	}

	return parts.join("\n");
}
