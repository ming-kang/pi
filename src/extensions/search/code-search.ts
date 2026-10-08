/**
 * code_search: Devin's SWE-grep model plans, this process executes.
 *
 * Each round sends the transcript to Devin, which replies with one tool call: `restricted_exec`
 * (up to eight rg/readfile/tree commands, run locally by `Workspace`) or `answer` (an `<ANSWER>`
 * document of files and line ranges). After `MAX_TURNS` rounds the answer is demanded.
 */
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { type ChatMessage, chat } from "./devin.ts";
import {
	FORCE_ANSWER,
	MAX_COMMANDS,
	MAX_RESULTS,
	MAX_TURNS,
	RETRY_TOOL_CALL,
	SYSTEM_PROMPT,
	TOOL_DEFINITIONS,
} from "./prompt.ts";
import { type Command, VIRTUAL_ROOT, Workspace } from "./workspace.ts";

export interface CodeLocation {
	/** Relative to the session's working directory. */
	path: string;
	ranges: Array<[number, number]>;
}

export interface CodeSearchOptions {
	apiKey: string;
	query: string;
	/** Directory to search; already confined to the working directory by the caller. */
	root: string;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	/** Test seam for the local `rg` backend. */
	workspace?: Workspace;
}

export async function codeSearch(options: CodeSearchOptions): Promise<CodeLocation[]> {
	const { apiKey, query, signal } = options;
	const progress = options.onProgress ?? (() => {});
	const workspace = options.workspace ?? new Workspace(options.root);
	const map = workspace.repoMap();
	const messages: ChatMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		{
			role: "user",
			content: `Problem Statement: ${query}\n\nRepo Map (tree -L ${map.depth} ${VIRTUAL_ROOT}):\n\`\`\`text\n${map.tree}\n\`\`\``,
		},
	];

	for (let turn = 1; turn <= MAX_TURNS + 1; turn++) {
		if (turn === MAX_TURNS + 1) messages.push({ role: "user", content: FORCE_ANSWER });
		progress(turn > MAX_TURNS ? "Collecting the answer…" : `Planning (round ${turn}/${MAX_TURNS})…`);
		const reply = await chat(apiKey, messages, TOOL_DEFINITIONS, signal);
		const call = parseToolCall(reply);

		if (call?.name === "answer") {
			return parseAnswer(String(call.args.answer ?? ""), workspace, options.cwd);
		}
		if (call?.name !== "restricted_exec") {
			messages.push({ role: "assistant", content: reply }, { role: "user", content: RETRY_TOOL_CALL });
			continue;
		}

		const keys = Object.keys(call.args)
			.filter((k) => /^command\d+$/.test(k))
			.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
			.slice(0, MAX_COMMANDS);
		progress(`Running ${keys.length} ${keys.length === 1 ? "command" : "commands"} (round ${turn}/${MAX_TURNS})…`);
		const results = await Promise.all(
			keys.map(
				async (k) => `<${k}_result>\n${await workspace.run(call.args[k] as Command, signal)}\n</${k}_result>`,
			),
		);
		const id = randomUUID();
		messages.push(
			{
				role: "assistant",
				content: call.thinking,
				call: { id, name: call.name, arguments: JSON.stringify(call.args) },
			},
			{ role: "tool", content: results.join(""), callId: id },
		);
	}
	return [];
}

export interface ToolCall {
	thinking: string;
	name: string;
	args: Record<string, unknown>;
}

/** `thinking[TOOL_CALLS]name[ARGS]{json}`. The JSON is the first balanced object, repaired if needed. */
export function parseToolCall(text: string): ToolCall | null {
	const m = text.match(/\[TOOL_CALLS\]\s*(\w+)\s*\[ARGS\]\s*(\{[\s\S]*)/);
	if (!m) return null;
	// Repair before scanning: a stray key quote would otherwise end the scan inside a "string".
	for (const candidate of [firstObject(m[2]!), firstObject(repairKeys(m[2]!))]) {
		try {
			const args = JSON.parse(candidate) as unknown;
			if (args && typeof args === "object" && !Array.isArray(args)) {
				return { thinking: text.slice(0, m.index).trim(), name: m[1]!, args: args as Record<string, unknown> };
			}
		} catch {}
	}
	return null;
}

function firstObject(text: string): string {
	let depth = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
		} else if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return text.slice(0, i + 1);
	}
	return text;
}

/** The planner sometimes drops a key's quotes, as in `,exclude":[]` or `{path:"…"}`. */
function repairKeys(json: string): string {
	return json.replace(/([{,]\s*)"?([A-Za-z_]\w*)"?\s*:/g, '$1"$2":');
}

const FILE_RE = /<file\s+path=(["'])(.+?)\1\s*>([\s\S]*?)<\/file>/g;
const RANGE_RE = /<range>\s*(\d+)\s*-\s*(\d+)\s*<\/range>/g;

/** The files of an `<ANSWER>`, each re-checked against the workspace; anything outside it is dropped. */
export function parseAnswer(xml: string, workspace: Workspace, cwd: string): CodeLocation[] {
	const locations: CodeLocation[] = [];
	for (const [, , path, body] of xml.matchAll(FILE_RE)) {
		const real = workspace.toReal(path);
		if (!real) continue;
		locations.push({
			path: relative(cwd, real).replace(/\\/g, "/") || ".",
			ranges: [...body!.matchAll(RANGE_RE)]
				.map(([, start, end]): [number, number] => [Number(start), Number(end)])
				.sort((a, b) => a[0] - b[0]),
		});
		if (locations.length === MAX_RESULTS) break;
	}
	return locations;
}

export function formatLocations(locations: CodeLocation[]): string {
	if (!locations.length)
		return "No relevant code found. Try a narrower behavioral query, or grep for a known identifier.";
	const lines = locations.map(
		({ path, ranges }) => `${path}${ranges.length ? ` (${ranges.map(([s, e]) => `L${s}-${e}`).join(", ")})` : ""}`,
	);
	return `${locations.length} candidate ${locations.length === 1 ? "location" : "locations"}; read them before relying on them:\n${lines.join("\n")}`;
}
