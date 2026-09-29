import { getShellConfig } from "../../utils/shell.ts";
import { rewriteCmdNulRedirects } from "./shell-execution.ts";
import {
	type BashOperations,
	type BashToolOptions,
	bashToolSystemPromptContribution,
	createLocalShellOperations,
	createShellToolDefinition,
	type ShellToolConfig,
} from "./shell-tool.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export {
	type BashOperations,
	type BashRenderState,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashToolSystemPromptContribution,
} from "./shell-tool.ts";
export function normalizeLocalBashCommand(command: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? rewriteCmdNulRedirects(command) : command;
}

export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath), normalizeLocalBashCommand);
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ReturnType<typeof createShellToolDefinition> {
	return createShellToolDefinition(cwd, bashToolConfig, {
		...options,
		operations: options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath }),
	});
}

export function createBashTool(cwd: string, options?: BashToolOptions) {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
