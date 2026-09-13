/**
 * then_run — fuse a file mutation and its follow-up command into one tool call.
 *
 * Edit/write rollouts repeatedly pair a mutation with a predictable validation
 * command (run, build, test, check). Carrying an optional `then_run` object lets
 * the mutation tool run that command itself and return one combined result,
 * removing a model round-trip between the two steps.
 *
 * The command executes through the same local shell machinery as the bash tool
 * (shared truncation, full-output spill, timeout contract) and always runs in
 * the foreground inside the mutation's file-queue slot.
 */

import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionContext } from "../extensions/types.ts";
import { type BashToolOptions, createLocalBashOperations, resolveSpawnContext } from "./bash.ts";
import { runShellCommand } from "./shell-execution.ts";

export const THEN_RUN_SKIPPED = "[then_run: skipped]";

/** Optional `then_run` parameter shared by the edit and write tool schemas. */
export const thenRunSchema = Type.Optional(
	Type.Object(
		{
			command: Type.String({
				description: "Command to run next on this file after it is saved — e.g. run, build, test, or check it",
			}),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
		},
		{
			description:
				"Run a follow-up command on this file in the same tool call after the mutation succeeds. Skipped if the mutation fails; a non-zero exit is reported as an error but keeps the file changes.",
		},
	),
);

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

/** Compact, display-oriented record of a fused command execution. */
export interface ThenRunDetails {
	command: string;
	/** "skipped" covers a refused run (file changed externally); failures throw instead. */
	status: "succeeded" | "skipped";
	exitCode: number | null;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface ThenRunOutcome {
	/** Model-facing section appended after the mutation text. */
	text: string;
	details: ThenRunDetails;
	/** Set when the command failed; the caller throws so the tool result is marked as an error. */
	failure?: string;
}

async function fileSha256(readFile: (path: string) => Promise<Buffer>, path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

/** Error appended to a failed mutation when a fused command was requested. */
export function thenRunSkippedError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(
		`${message}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
	);
}

/**
 * Run a fused follow-up command after a successful mutation. Callers must hold
 * the file mutation queue for `absolutePath`, which serializes Pi's own writers;
 * the sha256 check before the command catches external writers (watchers,
 * formatters) instead.
 */
export async function executeThenRun(params: {
	thenRun: ThenRunInput;
	absolutePath: string;
	cwd: string;
	shell?: BashToolOptions;
	signal?: AbortSignal;
	readFile: (path: string) => Promise<Buffer>;
	ctx?: ExtensionContext;
}): Promise<ThenRunOutcome> {
	const { thenRun, absolutePath, cwd, shell, signal, readFile, ctx } = params;
	const header = `[then_run] $ ${thenRun.command}`;
	const details: ThenRunDetails = { command: thenRun.command, status: "skipped", exitCode: null, truncated: false };

	try {
		const before = await fileSha256(readFile, absolutePath);
		await yieldToEventLoop();
		const after = await fileSha256(readFile, absolutePath);
		if (before !== after) {
			return {
				text: `${THEN_RUN_SKIPPED} The file changed on disk after the mutation; the command was not run.`,
				details,
			};
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			text: `${THEN_RUN_SKIPPED} Could not verify the mutated file (${reason}); the command was not run.`,
			details,
		};
	}

	const operations = shell?.operations ?? createLocalBashOperations({ shellPath: shell?.shellPath });
	const command = shell?.commandPrefix ? `${shell.commandPrefix}\n${thenRun.command}` : thenRun.command;
	const context = resolveSpawnContext(command, cwd, shell?.spawnHook, shell?.exposeSessionEnvironment ?? true, ctx);
	const completion = await runShellCommand({
		operations,
		shellName: "bash",
		context,
		tempFilePrefix: "pi-bash",
		timeout: thenRun.timeout,
		signal,
	});

	const output = completion.result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	details.status = "succeeded";
	details.exitCode = completion.exitCode ?? null;
	details.truncated = completion.result.details?.truncation?.truncated ?? false;
	details.fullOutputPath = completion.result.details?.fullOutputPath;

	if (completion.status) {
		return { text: `${header}\n${output}`, details, failure: completion.error ?? "Command failed" };
	}
	return { text: `${header}\n${output || "(no output)"}`, details };
}
