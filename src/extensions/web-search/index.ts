/**
 * web_search — Pi-native Web Search extension combining MiniMax and DeepSeek search engines.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { configuredEngine, resolveSearchCredentials } from "./auth.ts";
import {
	getWebSearchPromptGuidelines,
	WEB_SEARCH_DESCRIPTION,
	WEB_SEARCH_LABEL,
	WEB_SEARCH_PROMPT_SNIPPET,
	WEB_SEARCH_TOOL_NAME,
} from "./constants.ts";
import { executeWebSearch } from "./execute.ts";
import { formatSearchOutput } from "./format.ts";
import { renderWebSearchCall, renderWebSearchResult, type WebSearchRenderState } from "./render.ts";
import { normalizeWebSearchParams, WebSearchParamsSchema } from "./schema.ts";
import type { WebSearchDetails } from "./types.ts";

export default function webSearch(pi: ExtensionAPI): void {
	pi.registerTool<typeof WebSearchParamsSchema, WebSearchDetails, WebSearchRenderState>({
		name: WEB_SEARCH_TOOL_NAME,
		label: WEB_SEARCH_LABEL,
		description: WEB_SEARCH_DESCRIPTION,
		promptSnippet: WEB_SEARCH_PROMPT_SNIPPET,
		promptGuidelines: getWebSearchPromptGuidelines(),
		parameters: WebSearchParamsSchema,
		prepareArguments: normalizeWebSearchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const credentials = await resolveSearchCredentials(ctx.modelRuntime);
			const details = await executeWebSearch(params, credentials, signal, onUpdate);

			return {
				content: [{ type: "text", text: formatSearchOutput(details) }],
				details,
			};
		},

		renderCall: renderWebSearchCall,

		renderResult: renderWebSearchResult,
	});

	// Keep the tool out of the model's tool set (and system prompt) when no search
	// credentials are configured. Re-evaluated on every session start (startup,
	// /new, /reload, resume, fork), so /login takes effect from the next session
	// onward; the tool stays registered for /tools and historical rendering.
	pi.on("session_start", async (_event, ctx) => {
		const credentials = await resolveSearchCredentials(ctx.modelRuntime);
		if (configuredEngine(credentials) !== "none") return;
		const active = new Set(pi.getActiveTools());
		if (active.delete(WEB_SEARCH_TOOL_NAME)) pi.setActiveTools([...active]);
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== WEB_SEARCH_TOOL_NAME) return;
		const details = event.details as WebSearchDetails | undefined;
		if (details?.status === "error") return { isError: true };
	});
}
