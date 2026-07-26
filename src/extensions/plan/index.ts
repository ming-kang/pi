/**
 * plan — Claude-Code-style plan mode: read-only exploration and interview,
 * then a user-approved exit that saves the plan and optionally compacts.
 *
 * Shape:
 * - Entry (/plan or --plan) removes write-capable tools (edit/write/bash/
 *   subagent) and activates exit_plan; a tool_call guard covers requests
 *   already in flight before the tool-set change lands.
 * - The plan text travels as an exit_plan parameter, so the model needs no
 *   write access to produce the plan file.
 * - "Compact, then execute" keeps plan mode active until compaction completes
 *   (tools are restored in onComplete) and terminates the run via the tool
 *   result, so there is no window where the model holds full context plus
 *   write tools. The kickoff message embeds the plan itself — continuation
 *   never depends on the compaction summary preserving a path.
 * - State is conversation-backed via custom entries and branch replay (same
 *   pattern as todo): /reload, /tree, resume, and fork all restore.
 */
import { Text } from "@earendil-works/pi-tui";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionMode,
} from "../../core/extensions/types.ts";
import {
	buildPlanModePrompt,
	EXIT_PLAN_CANCEL_HINT,
	EXIT_PLAN_MENU_OPTIONS,
	EXIT_PLAN_PROMPT_GUIDELINES,
	EXIT_PLAN_PROMPT_SNIPPET,
	EXIT_PLAN_TOOL_DESCRIPTION,
	EXIT_PLAN_TOOL_LABEL,
	EXIT_PLAN_TOOL_NAME,
	MENU_COMPACT_EXECUTE,
	MENU_EXECUTE,
	MENU_KEEP_PLANNING,
	PLAN_BLOCKED_TOOLS,
	PLAN_COMMAND_NAME,
	PLAN_EMBED_MAX_CHARS,
	PLAN_ENTRY_TYPE,
	PLAN_FLAG_NAME,
	PLAN_STATUS_KEY,
} from "./constants.ts";
import { type ExitPlanDetails, type ExitPlanParams, ExitPlanParamsSchema } from "./schema.ts";
import {
	clonePlanState,
	disposePlanSession,
	EMPTY_PLAN_STATE,
	getPlanState,
	replacePlanState,
	replayPlanFromBranch,
	setActivePlanSession,
} from "./state.ts";
import { savePlanFile } from "./storage.ts";
import { formatApprovalSubtitle, formatExitPlanCall, formatExitPlanResult } from "./view.ts";

interface PendingCompact {
	title: string;
	plan: string;
	planPath: string;
}

function buildKickoffMessage(pending: PendingCompact): string {
	const truncated = pending.plan.length > PLAN_EMBED_MAX_CHARS;
	const body = truncated
		? `${pending.plan.slice(0, PLAN_EMBED_MAX_CHARS)}\n\n[Plan truncated — read the full plan at ${pending.planPath}]`
		: pending.plan;
	return `Execute the approved plan "${pending.title}" (saved at ${pending.planPath}).

${body}

Start now. Track multi-step work with the todo tool, and report back instead of improvising if the plan turns out to need revision.`;
}

export default function plan(pi: ExtensionAPI): void {
	let menuOpen = false;
	let pendingCompact: PendingCompact | undefined;

	pi.registerFlag(PLAN_FLAG_NAME, {
		description: "Start in plan mode (read-only planning)",
		type: "boolean",
		default: false,
	});

	/** Remove blocked tools, activate exit_plan, and return what was actually removed. */
	function applyPlanTools(): string[] {
		const active = pi.getActiveTools();
		const removed = active.filter((name) => PLAN_BLOCKED_TOOLS.has(name));
		pi.setActiveTools([...new Set([...active.filter((name) => !PLAN_BLOCKED_TOOLS.has(name)), EXIT_PLAN_TOOL_NAME])]);
		return removed;
	}

	/** Inverse of applyPlanTools: drop exit_plan, re-add exactly what was removed. */
	function restoreTools(removedTools: string[]): void {
		const active = pi.getActiveTools().filter((name) => name !== EXIT_PLAN_TOOL_NAME);
		pi.setActiveTools([...new Set([...active, ...removedTools])]);
	}

	function persist(): void {
		pi.appendEntry(PLAN_ENTRY_TYPE, getPlanState());
	}

	function updateStatus(ctx: ExtensionContext): void {
		const state = getPlanState();
		ctx.ui.setStatus(PLAN_STATUS_KEY, state.planning ? ctx.ui.theme.fg("accent", "Plan Mode") : undefined);
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		const state = getPlanState();
		if (state.planning) return;
		const removedTools = applyPlanTools();
		replacePlanState({ planning: true, removedTools, awaitingCompact: false, planFiles: state.planFiles });
		persist();
		updateStatus(ctx);
		ctx.ui.notify("Plan mode enabled: edit, write, bash, and subagent are disabled.", "info");
	}

	function exitPlanMode(ctx: ExtensionContext, notifyText?: string): void {
		const state = getPlanState();
		restoreTools(state.removedTools);
		replacePlanState({ ...state, planning: false, awaitingCompact: false, removedTools: [] });
		persist();
		updateStatus(ctx);
		if (notifyText) ctx.ui.notify(notifyText, "info");
	}

	/** Save the approved plan, index it in state, and name the session if unnamed. */
	function saveApprovedPlan(ctx: ExtensionContext, params: ExitPlanParams, title: string): string {
		const planPath = savePlanFile({
			sessionId: ctx.sessionManager.getSessionId(),
			title,
			plan: params.plan,
			cwd: ctx.cwd,
			revises: params.revises,
		});
		const state = getPlanState();
		replacePlanState({ ...state, planFiles: [...state.planFiles, planPath] });
		if (!pi.getSessionName()) pi.setSessionName(title);
		return planPath;
	}

	/**
	 * Rebuild state from the current branch and reconcile the live tool set.
	 * An interrupted compact-and-execute approval (restart, resume, branch
	 * switch) degrades to the keep-context exit so the approval is honored.
	 */
	function syncFromBranch(ctx: ExtensionContext, options?: { applyFlag?: boolean }): void {
		setActivePlanSession(ctx.sessionManager.getSessionId());
		const before = getPlanState();
		const replayed = replayPlanFromBranch(ctx);
		const next = replayed ?? clonePlanState(EMPTY_PLAN_STATE);
		if (!replayed && options?.applyFlag && pi.getFlag(PLAN_FLAG_NAME) === true) {
			next.planning = true;
		}

		let interruptedCompact = false;
		if (next.awaitingCompact) {
			next.planning = false;
			next.awaitingCompact = false;
			interruptedCompact = true;
			pendingCompact = undefined;
		}

		if (next.planning) {
			// The fresh removal set is authoritative for the eventual restore:
			// the live tool set may differ from what the entry recorded.
			next.removedTools = applyPlanTools();
		} else {
			if (pi.getActiveTools().includes(EXIT_PLAN_TOOL_NAME)) {
				restoreTools(before.planning ? before.removedTools : next.removedTools);
			}
			next.removedTools = [];
		}

		replacePlanState(next);
		if (interruptedCompact) {
			persist();
			ctx.ui.notify("Pending compaction was interrupted; plan mode exited with context kept.", "warning");
		}
		updateStatus(ctx);
	}

	pi.registerTool({
		name: EXIT_PLAN_TOOL_NAME,
		label: EXIT_PLAN_TOOL_LABEL,
		description: EXIT_PLAN_TOOL_DESCRIPTION,
		promptSnippet: EXIT_PLAN_PROMPT_SNIPPET,
		promptGuidelines: EXIT_PLAN_PROMPT_GUIDELINES,
		parameters: ExitPlanParamsSchema,
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<ExitPlanDetails>> {
			setActivePlanSession(ctx.sessionManager.getSessionId());
			const state = getPlanState();
			const title = params.title.trim() || "plan";

			if (!state.planning || state.awaitingCompact) {
				return {
					content: [
						{ type: "text", text: "Plan mode is not awaiting an exit; continue with your current instructions." },
					],
					details: { decision: "cancelled", title },
				};
			}

			if (!ctx.hasUI) {
				// json/print: no way to ask, so honor the least surprising default —
				// exit with context kept. Documented as a headless-mode semantic.
				const planPath = saveApprovedPlan(ctx, params, title);
				exitPlanMode(ctx);
				return {
					content: [
						{
							type: "text",
							text: `Plan saved to ${planPath}. No interactive UI, so plan mode exited with context kept (authoritative: write tools are restored). Begin executing the plan now.`,
						},
					],
					details: { decision: "execute", title, planPath },
				};
			}

			let choice: string | undefined;
			menuOpen = true;
			try {
				choice = await ctx.ui.select(`Approve plan "${title}"?`, EXIT_PLAN_MENU_OPTIONS, {
					signal,
					subtitle: formatApprovalSubtitle(ctx),
					cancelHint: EXIT_PLAN_CANCEL_HINT,
				});
			} finally {
				menuOpen = false;
			}

			if (signal?.aborted) {
				// Throwing lets Pi mark the result as an error, matching the todo convention.
				throw new Error("Plan approval was interrupted; plan mode is still active.");
			}

			if (choice === MENU_EXECUTE) {
				const planPath = saveApprovedPlan(ctx, params, title);
				exitPlanMode(ctx, "Plan approved: executing with full context.");
				return {
					content: [
						{
							type: "text",
							text: `Plan approved and saved to ${planPath}. Plan mode has ended and write tools are restored (authoritative — overrides the plan-mode system prompt block). Begin executing the plan now; track multi-step work with the todo tool.`,
						},
					],
					details: { decision: "execute", title, planPath },
				};
			}

			if (choice === MENU_COMPACT_EXECUTE) {
				const planPath = saveApprovedPlan(ctx, params, title);
				// Stay in plan mode (tools restricted) until compaction completes;
				// terminate ends the run so agent_settled can start the compaction.
				replacePlanState({ ...getPlanState(), awaitingCompact: true });
				persist();
				pendingCompact = { title, plan: params.plan, planPath };
				return {
					content: [
						{
							type: "text",
							text: `Plan approved and saved to ${planPath}. The context will now be compacted; stop here — execution restarts automatically after compaction.`,
						},
					],
					details: { decision: "compactAndExecute", title, planPath },
					terminate: true,
				};
			}

			// Explicit "Keep planning", Esc, or timeout: the only side-effect-free
			// choice, so any dismissal maps here.
			let feedback: string | undefined;
			if (choice === MENU_KEEP_PLANNING) {
				feedback =
					ctx.mode === "tui"
						? await ctx.ui.editor("Feedback for the plan (optional):", "")
						: await ctx.ui.input("Feedback for the plan (optional):");
			}
			const trimmedFeedback = feedback?.trim();
			return {
				content: [
					{
						type: "text",
						text: trimmedFeedback
							? `The user wants to keep planning. Feedback:\n${trimmedFeedback}`
							: "The user wants to keep planning. Ask what should change, or keep refining the open points.",
					},
				],
				details: { decision: "keepPlanning", title },
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatExitPlanCall(args, theme, context.expanded));
			return text;
		},

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatExitPlanResult(result, theme));
			return text;
		},
	});

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Toggle plan mode (read-only planning with user-approved exit)",
		handler: async (_args, ctx) => {
			setActivePlanSession(ctx.sessionManager.getSessionId());
			const state = getPlanState();
			if (menuOpen) {
				ctx.ui.notify("The exit_plan approval menu is open — answer it first.", "warning");
				return;
			}
			if (state.awaitingCompact) {
				ctx.ui.notify("Waiting for compaction to finish before leaving plan mode.", "warning");
				return;
			}
			if (state.planning) {
				exitPlanMode(ctx, "Plan mode disabled: full tool access restored.");
			} else {
				enterPlanMode(ctx);
			}
		},
	});

	// Defense in depth: the active-tools change lands on the next LLM request,
	// so a request already in flight when plan mode toggled can still carry
	// blocked tool calls.
	pi.on("tool_call", async (event, ctx) => {
		setActivePlanSession(ctx.sessionManager.getSessionId());
		const state = getPlanState();
		if (!state.planning || !PLAN_BLOCKED_TOOLS.has(event.toolName)) return;
		return {
			block: true,
			reason: `Plan mode: ${event.toolName} is disabled. Keep exploring with read-only tools, or call ${EXIT_PLAN_TOOL_NAME} to submit the plan for approval.`,
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setActivePlanSession(ctx.sessionManager.getSessionId());
		const state = getPlanState();
		if (!state.planning) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt(state.planFiles)}` };
	});

	// agent_settled fires once per fully settled run (agent_end can repeat on
	// retries and queued continuations), so the approved compaction starts here.
	pi.on("agent_settled", async (_event, ctx) => {
		setActivePlanSession(ctx.sessionManager.getSessionId());
		if (!getPlanState().awaitingCompact || !pendingCompact) return;
		const pending = pendingCompact;
		pendingCompact = undefined;
		ctx.compact({
			customInstructions: `The user approved an implementation plan saved at ${pending.planPath}. Preserve decisions, constraints, and rejected alternatives from the planning discussion that are not already written in the plan file.`,
			onComplete: () => {
				exitPlanMode(ctx, "Context compacted; executing the plan.");
				pi.sendUserMessage(buildKickoffMessage(pending));
			},
			onError: (error) => {
				// Never leave the user stuck read-only: degrade to keep-context execution.
				exitPlanMode(ctx, `Compaction failed (${error.message}); executing with full context instead.`);
				pi.sendUserMessage(buildKickoffMessage(pending));
			},
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		syncFromBranch(ctx, { applyFlag: true });
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromBranch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		pendingCompact = undefined;
		disposePlanSession(ctx.sessionManager.getSessionId());
	});
}
