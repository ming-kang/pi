/** The planning loop: hand the backend a repo map, run the commands it asks for, collect its answer. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseAnswer } from "./answer.ts";
import {
	buildRequest,
	type ChatMessage,
	checkRateLimit,
	getCachedJwt,
	parseResponse,
	streamingRequest,
} from "./client.ts";
import { trimMessages } from "./context.ts";
import { classifyError, SearchError } from "./errors.ts";
import { type RestrictedCommand, ToolExecutor } from "./executor.ts";
import { buildSystemPrompt, FINAL_FORCE_ANSWER, getToolDefinitions } from "./prompt.ts";
import { buildRepoMap } from "./repo-map.ts";
import { PathSandbox, VIRTUAL_ROOT } from "./sandbox.ts";
import type { SearchMeta, SearchOptions, SearchResult } from "./types.ts";

/** The backend refuses a planning request above this size, so context is trimmed before sending. */
const MAX_PROTO_BYTES = 320 * 1024;
/** Extra planning rounds granted when a round comes back with nothing actionable. */
const MAX_COMPENSATIONS = 2;

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

	const sandbox = new PathSandbox(resolve(opts.projectRoot));
	const executor = new ToolExecutor(sandbox, grepFn);

	log("Authenticating…");
	const jwt = await getCachedJwt(apiKey);

	log("Checking rate limit…");
	if (!(await checkRateLimit(apiKey, jwt))) return { files: [], error: "Rate limited, please try again later" };

	const toolDefs = getToolDefinitions(maxCommands);
	const systemPrompt = buildSystemPrompt(maxTurns, maxCommands, maxResults);

	// The directory scorer probes candidate hotspots through the same grep the model will use.
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
	const map = await buildRepoMap(sandbox.realRoot, VIRTUAL_ROOT, {
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
	const hot = map.hotDirs.length ? ` · hot: ${map.hotDirs.join(", ")}` : "";
	log(
		`Mapped repo (${map.strategy}${hot}, ${(map.sizeBytes / 1024).toFixed(1)}KB${map.fellBack ? ", fell back" : ""})`,
	);

	const messages: ChatMessage[] = [
		{ role: 5, content: systemPrompt },
		{
			role: 1,
			content: `Problem Statement: ${query}\n\nRepo Map (tree -L ${map.depth} ${VIRTUAL_ROOT}):\n\`\`\`text\n${map.tree}\n\`\`\``,
		},
	];

	let contextTrimmed = false;
	const baseMeta = (): SearchMeta => ({
		treeDepth: map.depth,
		treeSizeKB: +(map.sizeBytes / 1024).toFixed(1),
		fellBack: map.fellBack,
		strategy: map.strategy,
		hotDirs: map.hotDirs,
		hotspotDepth: map.hotspotDepth,
		contextTrimmed: contextTrimmed || undefined,
	});
	const fail = (error: string, errorCode?: string): SearchResult => ({
		files: [],
		error,
		meta: { ...baseMeta(), errorCode },
	});
	const patterns = () => [...new Set(executor.collectedRgPatterns)];

	/** Whether the retry that failed was the one issued after trimming, which the caller reports. */
	let trimmedForRetry = false;

	/**
	 * One planning request. Context is trimmed up front when the payload is already too large, and
	 * trimmed once more in response to the backend's own payload or timeout rejection.
	 */
	const sendPlan = async (): Promise<Buffer> => {
		trimmedForRetry = false;
		let proto = buildRequest(apiKey, jwt, messages, toolDefs);
		if (proto.length > MAX_PROTO_BYTES && trimMessages(messages, query)) {
			contextTrimmed = true;
			log("Trimming context before request (payload large)…");
			proto = buildRequest(apiKey, jwt, messages, toolDefs);
		}
		try {
			return await streamingRequest(proto, timeoutMs);
		} catch (e) {
			const err = e instanceof SearchError ? e : classifyError(e as Error);
			const recoverable = err.code === "PAYLOAD_TOO_LARGE" || err.code === "TIMEOUT";
			if (!recoverable || !trimMessages(messages, query)) throw err;
			contextTrimmed = true;
			trimmedForRetry = true;
			log(`${err.code === "TIMEOUT" ? "Timed out" : "Payload too large"} — trimming context, retrying…`);
			return await streamingRequest(buildRequest(apiKey, jwt, messages, toolDefs), timeoutMs);
		}
	};

	const totalApiCalls = maxTurns + 1;
	let compensatedTurns = 0;
	let forceAnswerInjected = false;

	for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
		log(`Planning (turn ${turn + 1}/${totalApiCalls})`);

		let respData: Buffer;
		try {
			respData = await sendPlan();
		} catch (e) {
			const err = e instanceof SearchError ? e : classifyError(e as Error);
			const retryNote = trimmedForRetry ? " (retry after context trim also failed)" : "";
			return fail(`${err.code}: ${err.message}${retryNote}`, err.code);
		}

		const [thinking, toolInfo] = parseResponse(respData);
		if (toolInfo === null) {
			// The backend answered with an error frame, or in prose without calling a tool.
			return thinking.startsWith("[Error]") ? { files: [], error: thinking } : { files: [], rawResponse: thinking };
		}
		const [toolName, toolArgs] = toolInfo;

		if (toolName === "answer") {
			const answerXml = typeof toolArgs.answer === "string" ? toolArgs.answer : "";
			return { files: parseAnswer(answerXml, sandbox), rgPatterns: patterns(), meta: baseMeta() };
		}
		if (toolName !== "restricted_exec") continue;

		const callId = randomUUID();
		const args = toolArgs as Record<string, RestrictedCommand>;
		const commands = Object.keys(args).filter((k) => k.startsWith("command"));
		log(`Running ${commands.length} ${commands.length === 1 ? "command" : "commands"}`);

		const results = await executor.execToolCall(args, opts.signal);

		if (commands.every((k) => !args[k]?.type) && compensatedTurns < MAX_COMPENSATIONS) {
			compensatedTurns++;
			log(`Retrying (no actionable results) ${compensatedTurns}/${MAX_COMPENSATIONS}…`);
		}

		messages.push({
			role: 2,
			content: thinking,
			tool_call_id: callId,
			tool_name: "restricted_exec",
			tool_args_json: JSON.stringify(toolArgs),
		});
		messages.push({ role: 4, content: results, ref_call_id: callId });

		if (turn - compensatedTurns >= maxTurns - 1 && !forceAnswerInjected) {
			messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
			forceAnswerInjected = true;
			log("Requesting final answer…");
		}
	}

	return {
		files: [],
		error: "Max turns reached without getting an answer",
		rgPatterns: patterns(),
		meta: baseMeta(),
	};
}
