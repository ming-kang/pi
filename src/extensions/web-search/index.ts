/**
 * web_search — Pi-native Web Search extension combining MiniMax and DeepSeek search engines.
 */

import type { ExtensionAPI, ToolRenderContext } from "../../core/extensions/types.ts";
import { resolveSearchCredentials } from "./auth.ts";
import {
	getWebSearchPromptGuidelines,
	WEB_SEARCH_DESCRIPTION,
	WEB_SEARCH_LABEL,
	WEB_SEARCH_PROMPT_SNIPPET,
	WEB_SEARCH_TOOL_NAME,
} from "./constants.ts";
import { executeWebSearch } from "./fusion.ts";
import { renderWebSearchCall, renderWebSearchResult } from "./render.ts";
import { normalizeWebSearchParams, type WebSearchParams, WebSearchParamsSchema } from "./schema.ts";
import type { WebSearchDetails } from "./types.ts";

interface WebSearchRenderState {
	startedAt?: number;
	refreshTimer?: ReturnType<typeof setTimeout>;
}

function trackQueryElapsed(context: ToolRenderContext<WebSearchRenderState>, isPartial: boolean): number | undefined {
	const state = context.state;
	if (isPartial) {
		state.startedAt ??= Date.now();
		if (state.refreshTimer === undefined) {
			state.refreshTimer = setTimeout(() => {
				state.refreshTimer = undefined;
				context.invalidate();
			}, 1000);
			state.refreshTimer.unref?.();
		}
		return Date.now() - state.startedAt;
	}
	if (state.refreshTimer !== undefined) {
		clearTimeout(state.refreshTimer);
		state.refreshTimer = undefined;
	}
	return undefined;
}

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
			const credentials = resolveSearchCredentials(ctx.modelRuntime);

			if (credentials.mode === "none") {
				const disabledDetails: WebSearchDetails = {
					query: params.query || "",
					durationMs: 0,
					status: "disabled",
					engine: "none",
					totalHits: 0,
					hits: [],
					errorMessage: "Neither MiniMax nor DeepSeek API Key found in auth.json or environment variables",
				};
				return {
					content: [
						{
							type: "text",
							text: "Web search is disabled: Neither MiniMax nor DeepSeek API Key was found in auth.json or environment variables. Please add credentials via auth.json or environment variables (MINIMAX_API_KEY, DEEPSEEK_API_KEY).",
						},
					],
					details: disabledDetails,
					isError: true,
				};
			}

			const execution = await executeWebSearch(params, credentials, signal, onUpdate);

			return {
				content: [{ type: "text", text: execution.formattedOutput }],
				details: execution.details,
				isError: execution.details.status === "error",
			};
		},

		renderCall(args, theme) {
			return renderWebSearchCall(args as WebSearchParams, theme);
		},

		renderResult(result, options, theme, context) {
			const elapsedMs = trackQueryElapsed(context, options.isPartial);
			return renderWebSearchResult(result, options, theme, context.isError, elapsedMs);
		},
	});
}
