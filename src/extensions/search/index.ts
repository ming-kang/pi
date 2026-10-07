import type { ExtensionAPI } from "../../core/extensions/types.ts";
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
import { runCodeSearch } from "./execute.ts";
import { getApiKey } from "./keystore.ts";
import { reconcileSearchTools } from "./reconcile.ts";
import { CodeSearchParamsSchema, WebSearchParamsSchema } from "./schema.ts";
import { runWebSearch } from "./web.ts";

export default function search(pi: ExtensionAPI): void {
	pi.registerTool({
		name: CODE_TOOL_NAME,
		label: CODE_TOOL_LABEL,
		description: CODE_TOOL_DESCRIPTION,
		promptSnippet: CODE_TOOL_SNIPPET,
		promptGuidelines: CODE_TOOL_GUIDELINES,
		parameters: CodeSearchParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = getApiKey();
			if (!apiKey) {
				return {
					content: [
						{ type: "text", text: "Error: Devin Search is not configured. Run /search-key or /search-login." },
					],
					details: { errorMessage: "tool unavailable" },
				};
			}
			onUpdate?.({ content: [{ type: "text", text: "Consulting Devin…" }], details: {} });
			const onProgress = (msg: string) => onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });
			const { text, details } = await runCodeSearch(params, apiKey, ctx.cwd, signal, onProgress);
			return { content: [{ type: "text", text }], details };
		},
	});

	pi.registerTool({
		name: WEB_TOOL_NAME,
		label: WEB_TOOL_LABEL,
		description: WEB_TOOL_DESCRIPTION,
		promptSnippet: WEB_TOOL_SNIPPET,
		promptGuidelines: WEB_TOOL_GUIDELINES,
		parameters: WebSearchParamsSchema,

		async execute(_toolCallId, params, signal, onUpdate) {
			const apiKey = getApiKey();
			if (!apiKey) {
				return {
					content: [
						{ type: "text", text: "Error: Devin Search is not configured. Run /search-key or /search-login." },
					],
					details: { status: "error", errorMessage: "tool unavailable" },
				};
			}
			const onProgress = (msg: string) => onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });
			const { text, details } = await runWebSearch(params, apiKey, signal, onProgress);
			return { content: [{ type: "text", text }], details };
		},
	});

	registerCommands(pi);

	// Both hooks matter: session events cover startup/new/reload/resume, while
	pi.on("session_start", async () => {
		reconcileSearchTools(pi);
	});
	pi.on("before_agent_start", async () => {
		reconcileSearchTools(pi);
	});
}
