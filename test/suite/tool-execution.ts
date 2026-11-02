import type { TUI } from "@earendil-works/pi-tui";
import { type ToolDefinitionLike, withToolShell } from "../../src/extensions/tool-presentation/shell.ts";
import {
	ToolExecutionComponent as NativeToolExecutionComponent,
	type ToolExecutionOptions,
} from "../../src/modes/interactive/components/tool-execution.ts";

export type { ToolExecutionOptions };

/** Construct the native component with the same default presentation shell as the interactive chat. */
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
