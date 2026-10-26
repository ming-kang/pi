import type { TUI } from "@earendil-works/pi-tui";
import {
	ToolExecutionComponent as NativeToolExecutionComponent,
	type ToolExecutionOptions,
} from "../components/tool-execution.ts";
import { type ToolDefinitionLike, withToolShell } from "./shell.ts";

export type { ToolRenderers } from "../../../core/extensions/types.ts";
export type { ToolExecutionOptions } from "../components/tool-execution.ts";

/**
 * Compatibility entry point for the distribution's original tool-view import path.
 * Lifecycle and renderer composition live in the native component; this adapter only supplies
 * the default shell for callers that construct the old distribution component directly.
 */
export class ToolExecutionComponent extends NativeToolExecutionComponent {
	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinitionLike | undefined,
		ui: TUI,
		cwd: string,
	) {
		super(toolName, toolCallId, args, options, withToolShell(toolName, toolDefinition), ui, cwd);
	}
}
