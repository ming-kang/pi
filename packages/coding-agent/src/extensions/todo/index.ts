/**
 * todo — Pi-native task tracking for multi-step work.
 *
 * The state is intentionally conversation-backed: every tool result carries a
 * full snapshot in `details`, and lifecycle handlers replay the current branch.
 * This keeps /reload, compaction, and session-tree navigation aligned with the
 * conversation without adding a separate disk database. (Compaction-safe by
 * design: sessionManager.getBranch() returns the FULL branch history including
 * pre-compaction toolResult entries — only buildSessionContext summarizes.)
 *
 * State is keyed per session id (see state.ts): resume and /tree switches can
 * change the session within one process, and execute + lifecycle handlers
 * re-point the active bucket before touching state.
 */
import type { AgentToolResult, ExtensionAPI, ToolExecutionMode } from "../../core/extensions/types.ts";
import {
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_LABEL,
	TODO_TOOL_NAME,
	TODOS_COMMAND_NAME,
} from "./constants.ts";
import { TodoOverlay } from "./overlay.ts";
import { type TodoDetails, TodoParamsSchema } from "./schema.ts";
import {
	applyTodoMutation,
	buildTodoDetails,
	commitTodoState,
	disposeTodoSession,
	formatTodoContent,
	getTodoState,
	replaceTodoState,
	replayTodosFromBranch,
	setActiveTodoSession,
} from "./state.ts";
import { formatCommandList } from "./view.ts";

interface TodoSessionCtx {
	sessionManager: { getBranch(): Iterable<unknown>; getSessionId(): string };
}

function safeReplay(ctx: TodoSessionCtx): void {
	setActiveTodoSession(ctx.sessionManager.getSessionId());
	try {
		replaceTodoState(replayTodosFromBranch(ctx));
	} catch (error) {
		if (!/stale after session replacement/.test(String(error))) throw error;
	}
}

export default function todo(pi: ExtensionAPI): void {
	let overlay: TodoOverlay | undefined;

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: TODO_TOOL_LABEL,
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: TODO_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<TodoDetails>> {
			// Re-point the active bucket: resume//tree can switch sessions between
			// lifecycle events and this call.
			setActiveTodoSession(ctx.sessionManager.getSessionId());
			const result = applyTodoMutation(getTodoState(), params);
			if (result.operation.kind === "error") {
				throw new Error(result.operation.message);
			}
			commitTodoState(result.state);
			const text = formatTodoContent(result.operation, result.state);
			return {
				content: [{ type: "text", text }],
				details: buildTodoDetails(params, result.state, result.operation),
			};
		},
	});

	pi.registerCommand(TODOS_COMMAND_NAME, {
		description: "Show todos for the current conversation branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires an interactive UI.", "warning");
				return;
			}
			setActiveTodoSession(ctx.sessionManager.getSessionId());
			ctx.ui.notify(formatCommandList(getTodoState()), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		safeReplay(ctx);
		if (ctx.hasUI) {
			overlay ??= new TodoOverlay();
			overlay.setUI(ctx.ui);
			overlay.resetVisibility();
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		safeReplay(ctx);
		overlay?.resetVisibility();
		overlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		safeReplay(ctx);
		overlay?.resetVisibility();
		overlay?.update();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		disposeTodoSession(ctx.sessionManager.getSessionId());
		overlay?.dispose();
		overlay = undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
		overlay?.update();
	});
}
