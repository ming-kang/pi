import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { withToolShell } from "../../modes/interactive/tool-view/shell.ts";

/**
 * Distribution tool chrome. Only TUI shell metadata is attached here: renderer functions,
 * execution, and HTML export remain owned by their original providers.
 */
export default function toolPresentation(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => withToolShell(toolName, next()));
}
