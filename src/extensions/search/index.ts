import type { Static, TSchema } from "typebox";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/extensions/types.ts";
import { registerCommands } from "./commands.ts";
import {
	CODE_TOOL_DESCRIPTION,
	CODE_TOOL_GUIDELINES,
	CODE_TOOL_LABEL,
	CODE_TOOL_NAME,
	CODE_TOOL_SNIPPET,
	WEB_TOOL_DESCRIPTION,
	WEB_TOOL_GUIDELINES,
	WEB_TOOL_LABEL,
	WEB_TOOL_NAME,
	WEB_TOOL_SNIPPET,
} from "./constants.ts";
import { type CodeSearchDetails, runCodeSearch } from "./execute.ts";
import { getApiKey } from "./keystore.ts";
import { reconcileSearchTools } from "./reconcile.ts";
import { CodeSearchParamsSchema, WebSearchParamsSchema } from "./schema.ts";
import { runWebSearch, type WebSearchDetails } from "./web.ts";

const NOT_CONFIGURED = "Error: Devin Search is not configured. Run /search to sign in.";

interface SearchToolSpec<TParams extends TSchema, TDetails> {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: TParams;
	/** Details reported when no key is configured; the model only ever sees NOT_CONFIGURED. */
	unavailable: TDetails;
	/** Progress line shown before the runner emits its own. */
	startMessage?: string;
	/** Let the tool frame its own output instead of the standard shell. */
	renderShell?: "self";
	run(
		params: Static<TParams>,
		apiKey: string,
		ctx: ExtensionToolContext,
		onProgress: (msg: string) => void,
		signal?: AbortSignal,
	): Promise<{ text: string; details: TDetails }>;
}

/**
 * Both search tools share one contract: hide behind a configured key, stream progress lines, and
 * return `{ text, details }`. Only the schema, the copy, and the runner differ.
 */
function registerSearchTool<TParams extends TSchema, TDetails>(
	pi: ExtensionAPI,
	spec: SearchToolSpec<TParams, TDetails>,
): void {
	pi.registerTool<TParams, TDetails>({
		name: spec.name,
		label: spec.label,
		description: spec.description,
		promptSnippet: spec.promptSnippet,
		promptGuidelines: spec.promptGuidelines,
		parameters: spec.parameters,
		...(spec.renderShell ? { renderShell: spec.renderShell } : {}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = getApiKey();
			if (!apiKey) {
				return { content: [{ type: "text" as const, text: NOT_CONFIGURED }], details: spec.unavailable };
			}
			// Progress updates carry no details; the final result is what callers read.
			const update = (text: string) =>
				onUpdate?.({ content: [{ type: "text" as const, text }], details: {} as TDetails });
			if (spec.startMessage) update(spec.startMessage);
			const { text, details } = await spec.run(params, apiKey, ctx, update, signal);
			return { content: [{ type: "text" as const, text }], details };
		},
	});
}

export default function search(pi: ExtensionAPI): void {
	registerSearchTool<typeof CodeSearchParamsSchema, CodeSearchDetails>(pi, {
		name: CODE_TOOL_NAME,
		label: CODE_TOOL_LABEL,
		description: CODE_TOOL_DESCRIPTION,
		promptSnippet: CODE_TOOL_SNIPPET,
		promptGuidelines: CODE_TOOL_GUIDELINES,
		parameters: CodeSearchParamsSchema,
		unavailable: { errorMessage: "tool unavailable" },
		startMessage: "Consulting Devin…",
		renderShell: "self",
		run: (params, apiKey, ctx, onProgress, signal) => runCodeSearch(params, apiKey, ctx.cwd, signal, onProgress),
	});

	registerSearchTool<typeof WebSearchParamsSchema, WebSearchDetails>(pi, {
		name: WEB_TOOL_NAME,
		label: WEB_TOOL_LABEL,
		description: WEB_TOOL_DESCRIPTION,
		promptSnippet: WEB_TOOL_SNIPPET,
		promptGuidelines: WEB_TOOL_GUIDELINES,
		parameters: WebSearchParamsSchema,
		unavailable: { status: "error", query: "", sources: [], truncated: false, errorMessage: "tool unavailable" },
		run: (params, apiKey, _ctx, onProgress, signal) => runWebSearch(params, apiKey, signal, onProgress),
	});

	registerCommands(pi);

	// Both hooks matter: session events cover startup/new/reload/resume, while
	// before_agent_start applies a mid-session key change without a restart.
	pi.on("session_start", async () => {
		reconcileSearchTools(pi);
	});
	pi.on("before_agent_start", async () => {
		reconcileSearchTools(pi);
	});
}
