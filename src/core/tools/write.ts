import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { BashToolOptions } from "./bash.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { executeThenRun, type ThenRunDetails, thenRunSchema, thenRunSkippedError } from "./then-run.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
	then_run: thenRunSchema,
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: [
		"Use write only for new files or complete rewrites.",
		"When the natural next step is to run, build, test, or check the written file, pass then_run to fuse the command into this call and save a round trip.",
	],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** Shell options for the fused then_run command. Default: local shell */
	thenRun?: BashToolOptions;
}

export interface WriteToolDetails {
	/** Fused follow-up command record, present when then_run was requested and ran */
	thenRun?: ThenRunDetails;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, content, then_run }: WriteToolInput,
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const thenRun = then_run?.command ? then_run : undefined;
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				let mutationResult: AgentToolResult<WriteToolDetails | undefined>;
				try {
					throwIfAborted();
					// Create parent directories if needed.
					await ops.mkdir(dir);
					throwIfAborted();

					// Write the file contents.
					await ops.writeFile(absolutePath, content);
					throwIfAborted();

					mutationResult = {
						content: [{ type: "text" as const, text: `Successfully wrote to ${path}` }],
						details: undefined,
					};
				} catch (error) {
					throw thenRun ? thenRunSkippedError(error) : error;
				}

				if (!thenRun) {
					return mutationResult;
				}

				throwIfAborted();
				const outcome = await executeThenRun({
					thenRun,
					absolutePath,
					cwd: ctx?.cwd || cwd,
					shell: options?.thenRun,
					signal,
					readFile: (filePath) => fsReadFile(filePath),
					ctx,
					onUpdate: onUpdate
						? (sectionText) =>
								onUpdate({
									content: [...mutationResult.content, { type: "text" as const, text: sectionText }],
									details: mutationResult.details,
								})
						: undefined,
				});
				const mutationText = mutationResult.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (outcome.failure) {
					throw new Error(`${mutationText}\n\n${outcome.text}`);
				}
				return {
					content: [...mutationResult.content, { type: "text" as const, text: outcome.text }],
					details: { thenRun: outcome.details },
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
