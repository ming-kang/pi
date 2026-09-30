/**
 * The `tool_search` tool as an extension. The CLI loads it as a built-in extension; SDK users add
 * `createToolSearchExtension()` to their extension factories.
 *
 * `tool_search` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createToolSearchToolDefinition, TOOL_SEARCH_TOOL_NAME, toolSearchSchema } from "./tool.ts";

export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.events.on("pi:discover-tool-orchestrators", (candidates) => {
			if (candidates instanceof Map && candidates.get(TOOL_SEARCH_TOOL_NAME) === toolSearchSchema) {
				candidates.set(TOOL_SEARCH_TOOL_NAME, true);
			}
		});
		pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });
	};
}

export default createToolSearchExtension();
