import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	buildRequest,
	type ChatMessage,
	checkRateLimit,
	classifyError,
	getCachedJwt,
	parseResponse,
	SearchError,
	streamingRequest,
} from "./client.ts";
import { type GrepFn, type RestrictedCommand, ToolExecutor } from "./executor.ts";
import { buildSystemPrompt, FINAL_FORCE_ANSWER, getToolDefinitions } from "./prompt.ts";
import { buildRepoMap } from "./repo-map.ts";
import { PathSandbox } from "./sandbox.ts";
import { truncateText } from "./text.ts";

const VIRTUAL_ROOT = "/codebase";

export interface SearchOptions {
	query: string;
	projectRoot: string;
	apiKey: string;
	grepFn: GrepFn;
	maxTurns?: number;
	maxCommands?: number;
	maxResults?: number;
	treeDepth?: number;
	timeoutMs?: number;
	excludePaths?: string[];
	repoMapMode?: "classic" | "hotspot";
	hotspotBaseDepth?: number;
	hotspotTopK?: number;
	hotspotTreeDepth?: number;
	hotspotMaxBytes?: number;
	onProgress?: (msg: string) => void;
	signal?: AbortSignal;
}

export interface SearchFile {
	path: string;
	fullPath: string;
	ranges: Array<[number, number]>;
}

export interface SearchMeta {
	treeDepth: number;
	treeSizeKB: number;
	fellBack: boolean;
	strategy?: "classic" | "hotspot";
	hotDirs?: string[];
	hotspotDepth?: number;
	errorCode?: string;
	contextTrimmed?: boolean;
}

export interface SearchResult {
	files: SearchFile[];
	rgPatterns?: string[];
	error?: string;
	rawResponse?: string;
	meta?: SearchMeta;
}

export function trimMessages(messages: ChatMessage[], query: string): boolean {
	if (messages.length < 2) return false;
	const system = messages[0]!;
	const user = messages[1]!;

	let resultIdx = -1;
	let refId: string | undefined;
	for (let i = messages.length - 1; i >= 2; i--) {
		const m = messages[i]!;
		if (m.role === 4 && m.ref_call_id) {
			resultIdx = i;
			refId = m.ref_call_id;
			break;
		}
	}
	let callIdx = -1;
	if (refId) {
		for (let i = resultIdx - 1; i >= 2; i--) {
			if (messages[i]!.role === 2 && messages[i]!.tool_call_id === refId) {
				callIdx = i;
				break;
			}
		}
	}
	const tailStart =
		resultIdx === -1 ? Math.max(2, messages.length - 2) : callIdx !== -1 ? callIdx : Math.max(2, resultIdx - 1);
	const tail = messages.slice(tailStart);

	const compactUser: ChatMessage = user.content.includes("Repo Map")
		? {
				...user,
				content: `Problem Statement: ${query}\n\nRepo Map: (omitted to reduce payload — use tree/rg to explore structure if needed).`,
			}
		: user;
	const didCompact = compactUser.content.length < user.content.length;
	const droppedHistory = tailStart > 2;
	if (!didCompact && !droppedHistory) return false;

	messages.length = 0;
	messages.push(
		system,
		compactUser,
		{ role: 1, content: "[Context trimmed to reduce payload. Continue from the most recent tool results below.]" },
		...tail,
	);
	return true;
}

export function parseAnswer(xmlText: string, sandbox: PathSandbox): SearchFile[] {
	const files: SearchFile[] = [];
	const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
	for (let fm = fileRegex.exec(xmlText); fm !== null; fm = fileRegex.exec(xmlText)) {
		const vpath = fm[2]!;
		const real = sandbox.toReal(vpath);
		if (real === null) continue;
		const rel = vpath.replace(/^\/codebase[/\\]?/, "").replace(/^[/\\]+/, "");
		const ranges: Array<[number, number]> = [];
		const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
		for (let rm = rangeRegex.exec(fm[3]!); rm !== null; rm = rangeRegex.exec(fm[3]!)) {
			ranges.push([Number.parseInt(rm[1]!, 10), Number.parseInt(rm[2]!, 10)]);
		}
		files.push({ path: rel, fullPath: real, ranges });
	}
	return files;
}

export async function search(opts: SearchOptions): Promise<SearchResult> {
	const {
		query,
		apiKey,
		grepFn,
		maxTurns = 3,
		maxCommands = 8,
		maxResults = 10,
		treeDepth = 3,
		timeoutMs = 30000,
		excludePaths = [],
		repoMapMode = "hotspot",
		hotspotBaseDepth = 1,
		hotspotTopK = 4,
		hotspotTreeDepth = 2,
		hotspotMaxBytes = 120 * 1024,
		onProgress,
	} = opts;
	const log = (m: string) => onProgress?.(m);

	const projectRoot = resolve(opts.projectRoot);
	const sandbox = new PathSandbox(projectRoot);
	const executor = new ToolExecutor(sandbox, grepFn);

	log("Authenticating…");
	const jwt = await getCachedJwt(apiKey);

	log("Checking rate limit…");
	if (!(await checkRateLimit(apiKey, jwt))) {
		return { files: [], error: "Rate limited, please try again later" };
	}

	const toolDefs = getToolDefinitions(maxCommands);
	const systemPrompt = buildSystemPrompt(maxTurns, maxCommands, maxResults);

	const probeFn = async (pattern: string, sig?: AbortSignal): Promise<string[]> => {
		let raw: string;
		try {
			raw = await grepFn(pattern, sandbox.realRoot, undefined, sig);
		} catch {
			return [];
		}
		const files = new Set<string>();
		for (const line of raw.split("\n")) {
			const m = line.match(/^(.+?):\d+:/);
			if (m?.[1]) files.add(m[1]);
		}
		return [...files];
	};

	log("Mapping repo…");
	const {
		tree: repoMap,
		depth: actualDepth,
		hotspotDepth,
		sizeBytes: treeSizeBytes,
		fellBack,
		strategy,
		hotDirs,
	} = await buildRepoMap(sandbox.realRoot, VIRTUAL_ROOT, {
		mode: repoMapMode,
		query,
		treeDepth,
		excludePaths,
		probeFn,
		hotspot: {
			baseDepth: hotspotBaseDepth,
			topK: hotspotTopK,
			hotspotDepth: hotspotTreeDepth,
			maxBytes: hotspotMaxBytes,
		},
		signal: opts.signal,
	});
	log(
		`Mapped repo (${strategy}${hotDirs.length ? ` · hot: ${hotDirs.join(", ")}` : ""}, ${(treeSizeBytes / 1024).toFixed(1)}KB${fellBack ? ", fell back" : ""})`,
	);

	const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;
	const messages: ChatMessage[] = [
		{ role: 5, content: systemPrompt },
		{ role: 1, content: userContent },
	];

	let contextWasTrimmed = false;
	const baseMeta = (): SearchMeta => ({
		treeDepth: actualDepth,
		treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
		fellBack,
		strategy,
		hotDirs,
		hotspotDepth,
		contextTrimmed: contextWasTrimmed || undefined,
	});

	const totalApiCalls = maxTurns + 1;
	let compensatedTurns = 0;
	const MAX_COMPENSATIONS = 2;
	let forceAnswerInjected = false;

	for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
		log(`Planning (turn ${turn + 1}/${totalApiCalls})`);
		let proto = buildRequest(apiKey, jwt, messages, toolDefs);

		const MAX_PROTO_BYTES = 320 * 1024;
		if (proto.length > MAX_PROTO_BYTES && trimMessages(messages, query)) {
			contextWasTrimmed = true;
			log("Trimming context before request (payload large)…");
			proto = buildRequest(apiKey, jwt, messages, toolDefs);
		}

		let respData: Buffer;
		try {
			respData = await streamingRequest(proto, timeoutMs);
		} catch (e) {
			const err = e instanceof SearchError ? e : classifyError(e as Error);
			const errCode = err.code;
			if ((errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT") && trimMessages(messages, query)) {
				contextWasTrimmed = true;
				log(`${errCode === "TIMEOUT" ? "Timed out" : "Payload too large"} — trimming context, retrying…`);
				try {
					respData = await streamingRequest(buildRequest(apiKey, jwt, messages, toolDefs), timeoutMs);
				} catch (retryErr) {
					const rc = retryErr instanceof SearchError ? retryErr.code : "UNKNOWN";
					return {
						files: [],
						error: `${rc}: ${(retryErr as Error).message} (retry after context trim also failed)`,
						meta: { ...baseMeta(), errorCode: rc, contextTrimmed: true },
					};
				}
			} else {
				return { files: [], error: `${errCode}: ${err.message}`, meta: { ...baseMeta(), errorCode: errCode } };
			}
		}

		const [thinking, toolInfo] = parseResponse(respData);
		if (toolInfo === null) {
			if (thinking.startsWith("[Error]")) return { files: [], error: thinking };
			return { files: [], rawResponse: thinking };
		}
		const [toolName, toolArgs] = toolInfo;

		if (toolName === "answer") {
			const answerXml = typeof toolArgs.answer === "string" ? toolArgs.answer : "";
			const files = parseAnswer(answerXml, sandbox);
			return {
				files,
				rgPatterns: [...new Set(executor.collectedRgPatterns)],
				meta: baseMeta(),
			};
		}

		if (toolName === "restricted_exec") {
			const callId = randomUUID();
			const argsJson = JSON.stringify(toolArgs);
			const args = toolArgs as Record<string, RestrictedCommand>;
			const cmds = Object.keys(args).filter((k) => k.startsWith("command"));
			log(`Running ${cmds.length} ${cmds.length === 1 ? "command" : "commands"}`);

			const results = await executor.execToolCall(args, opts.signal);

			const validCommands = cmds.filter((k) => args[k]?.type);
			if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
				compensatedTurns++;
				log(`Retrying (no actionable results) ${compensatedTurns}/${MAX_COMPENSATIONS}…`);
			}

			messages.push({
				role: 2,
				content: thinking,
				tool_call_id: callId,
				tool_name: "restricted_exec",
				tool_args_json: argsJson,
			});
			messages.push({ role: 4, content: results, ref_call_id: callId });

			const effectiveTurn = turn - compensatedTurns;
			if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
				messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
				forceAnswerInjected = true;
				log("Requesting final answer…");
			}
		}
	}

	return {
		files: [],
		error: "Max turns reached without getting an answer",
		rgPatterns: [...new Set(executor.collectedRgPatterns)],
		meta: baseMeta(),
	};
}

const RAW_RESPONSE_MAX_CHARS = 2000;

export interface FormatOptions {
	maxTurns: number;
	maxResults: number;
	maxCommands: number;
	timeoutMs: number;
	excludePaths: string[];
}

function hintFor(code?: string): string {
	if (code === "PAYLOAD_TOO_LARGE" || code === "TIMEOUT")
		return "\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.";
	if (code === "AUTH_ERROR")
		return "\n[hint] Devin authentication failed; re-authenticate with /search-login or set a new key with /search-key.";
	if (code === "RATE_LIMITED") return "\n[hint] Rate limited. Wait a moment and retry.";
	return "\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.";
}

export function formatSearchResult(result: SearchResult, fmt: FormatOptions): string {
	if (result.error) {
		const meta = result.meta;
		let errMsg = `Error: ${result.error}`;
		if (meta) {
			errMsg += `\n\n[diagnostic] error_type=${meta.errorCode ?? "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
			if (meta.fellBack) errMsg += " (auto fell back from requested depth)";
			if (meta.contextTrimmed) errMsg += ", context_trimmed=true";
			errMsg += `\n[config] max_turns=${fmt.maxTurns}, max_results=${fmt.maxResults}, max_commands=${fmt.maxCommands}, timeout_ms=${fmt.timeoutMs}`;
			if (meta.strategy) errMsg += `, strategy=${meta.strategy}`;
			if (meta.hotspotDepth) errMsg += `, hotspot_depth=${meta.hotspotDepth}`;
			if (meta.hotDirs?.length) errMsg += `, hot=[${meta.hotDirs.join(", ")}]`;
			if (fmt.excludePaths.length) errMsg += `, exclude_paths=[${fmt.excludePaths.join(", ")}]`;
			errMsg += hintFor(meta.errorCode);
		}
		return errMsg;
	}

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
	if (files.length) {
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
		const fb = meta.fellBack ? " (fell back from requested depth)" : "";
		const hot = meta.hotDirs?.length ? `, hot=[${meta.hotDirs.join(", ")}]` : "";
		const hotspotDepth = meta.hotspotDepth ? `, hotspot_depth=${meta.hotspotDepth}` : "";
		const strategy = meta.strategy ? `, strategy=${meta.strategy}${hotspotDepth}${hot}` : "";
		parts.push(
			"",
			`[config] tree_depth=${meta.treeDepth}${fb}, tree_size=${meta.treeSizeKB}KB${strategy}, max_turns=${fmt.maxTurns}, max_results=${fmt.maxResults}, timeout_ms=${fmt.timeoutMs}${fmt.excludePaths.length ? `, exclude_paths=[${fmt.excludePaths.join(", ")}]` : ""}`,
		);
	}

	return parts.join("\n");
}
