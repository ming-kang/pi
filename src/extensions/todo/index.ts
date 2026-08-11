/**
 * todo — Pi-native task tracking for multi-step work.
 *
 * State is conversation-backed: every tool result carries a full v2 snapshot
 * in `details`, and lifecycle handlers replay the current branch into the
 * closure store created by createTodoStore(). Resume, /reload, and /tree
 * navigation stay aligned with the conversation without a disk database or
 * any per-session global state.
 */
import { Text } from "@earendil-works/pi-tui";
import {
	type AgentToolResult,
	type ExtensionAPI,
	isStaleExtensionContextError,
	type ToolExecutionMode,
} from "../../core/extensions/types.ts";
import {
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_LABEL,
	TODO_TOOL_NAME,
	TODOS_COMMAND_NAME,
} from "./constants.ts";
import { type TodoDetails, TodoParamsSchema } from "./schema.ts";
import { createTodoStore, replayTodosFromBranch, type TodoStore } from "./state.ts";
import { formatCommandList, formatTodoCall, formatTodoContent, formatTodoGroupCall } from "./view.ts";
import { TodoWidget } from "./widget.ts";

interface TodoSessionCtx {
	sessionManager: { getBranch(): Iterable<unknown> };
}

function safeReplay(ctx: TodoSessionCtx, store: TodoStore): void {
	// Every ctx.sessionManager access stays inside the guard: a lifecycle event
	// can race session replacement (resume, /tree, /reload), and a stale ctx
	// just means another session took over — nothing left to replay for it.
	try {
		store.replaceState(replayTodosFromBranch(ctx));
	} catch (error) {
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

export default function todo(pi: ExtensionAPI): void {
	const store = createTodoStore();
	let widget: TodoWidget | undefined;

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: TODO_TOOL_LABEL,
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: TODO_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		executionMode: "sequential" as ToolExecutionMode,
		// Consecutive todo calls collapse into one run like read/find's `explore`
		// group; the widget already carries the live list, so the transcript only
		// needs the sequence of operations.
		toolGroup: TODO_TOOL_NAME,

		async execute(_toolCallId, params, _signal, _onUpdate): Promise<AgentToolResult<TodoDetails>> {
			// Validation errors throw before any state mutation, so the store is
			// untouched on failure.
			const details = store.execute(params);
			const text = formatTodoContent(details.change, details.state);
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				context.toolGroupSummary
					? formatTodoGroupCall(args, theme, context)
					: formatTodoCall(args, theme, context.expanded, context.result),
			);
			return text;
		},
	});

	pi.registerCommand(TODOS_COMMAND_NAME, {
		description: "Show the complete todo list for the current conversation branch",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires an interactive UI.", "warning");
				return;
			}
			ctx.ui.notify(formatCommandList(store.getState()), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		safeReplay(ctx, store);
		if (ctx.hasUI) {
			widget ??= new TodoWidget(() => store.getState());
			widget.setUI(ctx.ui);
			widget.update();
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		safeReplay(ctx, store);
		widget?.update();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// The store belongs to this extension runtime and is collected with it;
		// the next runtime restores its own store during session_start.
		widget?.dispose();
		widget = undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
		widget?.update();
	});
}
