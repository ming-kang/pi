/**
 * This distribution's additions to the extension API. `types.ts` re-exports them, so
 * extensions import them from the same place as the upstream API.
 */
import type { TerminalInputHandler } from "./types.ts";

export type { BackgroundContext } from "../background/types.ts";
export type { ContextSnapshot } from "../context-snapshot.ts";
export type { ModelRuntime } from "../model-runtime.ts";

export interface EditorSubmitEvent {
	/** Expanded, trimmed editor text, before history, command dispatch, or any main-agent queue. */
	text: string;
	kind: "prompt" | "command" | "bash";
	mode: "steer" | "followUp";
}

/** Handlers must claim input synchronously; start asynchronous work after claiming it. */
export type EditorSubmitHandler = (event: EditorSubmitEvent) => { handled: true; editorText?: string } | undefined;

/** Main-editor capabilities, present only where a host renders the interactive editor. */
export interface EditorHost {
	/** Intercept editor submissions, including during compaction. First claim wins. */
	onSubmit(handler: EditorSubmitHandler): () => void;
	/** Logical cursor position when the editor exposes it. Indices are zero-based. */
	getCursor(): { line: number; col: number } | undefined;
	/** Raw input only while the main editor has focus, without overlays or autocomplete. */
	onInput(handler: TerminalInputHandler): () => void;
}

/**
 * Upstream words the error it throws when a captured extension ctx/pi is used after the owning
 * session was replaced (newSession/fork/switchSession/reload) in three places. Recognize it by
 * its stable opening rather than copying the whole message, so extensions can detect the
 * condition with isStaleExtensionContextError instead of matching text themselves.
 */
const STALE_EXTENSION_CONTEXT_PREFIX = "This extension ctx is stale";

/** True when an error came from using a stale extension ctx/pi after session replacement. */
export function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_PREFIX);
}
