/**
 * deepwiki — Pi-native wrapper for DeepWiki repository documentation.
 *
 * Pi does not expose MCP servers as tools. This extension intentionally exposes
 * only one DeepWiki-specific tool and hard-codes DeepWiki's public operations.
 */
import type { ExtensionAPI, ToolRenderContext } from "../../core/extensions/types.ts";
import {
	DEEPWIKI_DESCRIPTION,
	DEEPWIKI_LABEL,
	DEEPWIKI_PROMPT_GUIDELINES,
	DEEPWIKI_PROMPT_SNIPPET,
	DEEPWIKI_TOOL_NAME,
} from "./constants.ts";

import { type DeepWikiDetails, executeDeepWiki } from "./execute.ts";
import { renderDeepWikiCall, renderDeepWikiResult } from "./render.ts";
import { type DeepWikiParams, DeepWikiParamsSchema, normalizeDeepWikiParams } from "./schema.ts";

interface DeepWikiRenderState {
	startedAt?: number;
	refreshTimer?: ReturnType<typeof setTimeout>;
}

// Track query duration and re-render once per second while the result is
// still partial; the first settled render clears the timer.
function trackQueryElapsed(context: ToolRenderContext<DeepWikiRenderState>, isPartial: boolean): number | undefined {
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

export default function deepwiki(pi: ExtensionAPI): void {
	pi.registerTool<typeof DeepWikiParamsSchema, DeepWikiDetails, DeepWikiRenderState>({
		name: DEEPWIKI_TOOL_NAME,
		label: DEEPWIKI_LABEL,
		description: DEEPWIKI_DESCRIPTION,
		promptSnippet: DEEPWIKI_PROMPT_SNIPPET,
		promptGuidelines: DEEPWIKI_PROMPT_GUIDELINES,
		parameters: DeepWikiParamsSchema,
		prepareArguments: normalizeDeepWikiParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			return executeDeepWiki(params, signal, onUpdate);
		},

		renderCall(args, theme) {
			return renderDeepWikiCall(args as DeepWikiParams, theme);
		},

		renderResult(result, options, theme, context) {
			const elapsedMs = trackQueryElapsed(context, options.isPartial);
			return renderDeepWikiResult(result, options, theme, context.isError, elapsedMs);
		},
	});
}
