/**
 * plan — Claude-Code-style plan mode: read-only exploration and interview,
 * then a user-approved exit that saves the plan and optionally compacts.
 *
 * Shape:
 * - Entry (/plan or --plan) snapshots the active tool set and swaps to the
 *   exploration set (read/grep/find/ls/bash + exit_plan; edit/write removed,
 *   bash prompt-constrained to read-only, subagent guarded to the explorer
 *   profile); a tool_call guard covers requests already in flight before the
 *   tool-set change lands.
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

import { basename } from "node:path";
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
	PLAN_ALLOWED_SUBAGENT,
	PLAN_BLOCKED_TOOLS,
	PLAN_COMMAND_NAME,
	PLAN_EMBED_MAX_CHARS,
	PLAN_ENTRY_TYPE,
	PLAN_EXPLORE_TOOLS,
	PLAN_FLAG_NAME,
	PLAN_PANEL_CANCEL_HINT,
	PLAN_PANEL_EXIT,
	PLAN_PANEL_EXIT_DESCRIPTION,
	PLAN_PANEL_MAX_FILES,
	PLAN_PANEL_TITLE,
	PLAN_STATUS_KEY,
	PLAN_SUBAGENT_TOOL_NAME,
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
import { listProjectPlanFiles, savePlanFile } from "./storage.ts";
import { formatApprovalSubtitle, formatExitPlanResult, renderExitPlanCall, shortenPlanPath } from "./view.ts";

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

/**
 * First subagent profile in the call that is not allowed in plan mode, or
 * undefined when every profile is the read-only explorer. An omitted or null
 * agent resolves to the default "general" profile, so it is disallowed too.
 * Args arrive off the wire, so every field is read defensively.
 */
export function findDisallowedSubagentProfile(input: unknown): string | undefined {
	const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const requested: unknown[] = Array.isArray(record.tasks)
		? record.tasks.map((task) =>
				task && typeof task === "object" ? (task as Record<string, unknown>).agent : undefined,
			)
		: [record.agent];
	for (const profile of requested) {
		const name = typeof profile === "string" && profile.trim() ? profile.trim() : "general";
		if (name !== PLAN_ALLOWED_SUBAGENT) return name;
	}
	return undefined;
}

export default function plan(pi: ExtensionAPI): void {
	let menuOpen = false;
	let pendingCompact: PendingCompact | undefined;

	pi.registerFlag(PLAN_FLAG_NAME, {
		description: "Start in plan mode (read-only planning)",
		type: "boolean",
		default: false,
	});

	/**
	 * Swap to the exploration tool set and return the pre-entry snapshot.
	 * Snapshot + delta rather than a fixed allowlist: edit/write are dropped,
	 * the explore tools (grep/find/ls are registered but not active by
	 * default) and exit_plan are added, and every other active tool — question,
	 * todo, deepwiki, subagent, ... — stays active.
	 */
	function applyPlanTools(): string[] {
		const snapshot = pi.getActiveTools();
		pi.setActiveTools([
			...new Set([
				...snapshot.filter((name) => !PLAN_BLOCKED_TOOLS.has(name)),
				...PLAN_EXPLORE_TOOLS,
				EXIT_PLAN_TOOL_NAME,
			]),
		]);
		return snapshot;
	}

	/**
	 * Inverse of applyPlanTools: restore the snapshot verbatim. An empty
	 * snapshot (legacy entries) only drops exit_plan — there is nothing
	 * recorded to restore to.
	 */
	function restoreTools(toolSnapshot: string[]): void {
		if (toolSnapshot.length > 0) {
			pi.setActiveTools([...new Set(toolSnapshot)].filter((name) => name !== EXIT_PLAN_TOOL_NAME));
			return;
		}
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== EXIT_PLAN_TOOL_NAME));
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
		const toolSnapshot = applyPlanTools();
		replacePlanState({ planning: true, toolSnapshot, awaitingCompact: false, planFiles: state.planFiles });
		persist();
		updateStatus(ctx);
		ctx.ui.notify(
			"Plan mode: read-only exploration — edit/write disabled, bash constrained to read-only, subagent limited to explorer.",
			"info",
		);
	}

	function exitPlanMode(ctx: ExtensionContext, notifyText?: string): void {
		const state = getPlanState();
		restoreTools(state.toolSnapshot);
		replacePlanState({ ...state, planning: false, awaitingCompact: false, toolSnapshot: [] });
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
			// Re-applying is idempotent, but the returned live snapshot is only
			// authoritative when the live set was NOT already restricted: on a
			// branch switch while planning, re-snapshotting would capture the
			// plan-mode set, so the in-memory snapshot wins there.
			const liveSnapshot = applyPlanTools();
			next.toolSnapshot =
				before.planning && before.toolSnapshot.length > 0 ? [...before.toolSnapshot] : liveSnapshot;
		} else {
			if (pi.getActiveTools().includes(EXIT_PLAN_TOOL_NAME)) {
				restoreTools(before.planning ? before.toolSnapshot : next.toolSnapshot);
			}
			next.toolSnapshot = [];
		}

		replacePlanState(next);
		if (interruptedCompact) {
			persist();
			ctx.ui.notify("Pending compaction was interrupted; plan mode exited with context kept.", "warning");
		}
		updateStatus(ctx);
	}

	pi.registerTool<typeof ExitPlanParamsSchema, ExitPlanDetails>({
		name: EXIT_PLAN_TOOL_NAME,
		label: EXIT_PLAN_TOOL_LABEL,
		description: EXIT_PLAN_TOOL_DESCRIPTION,
		promptSnippet: EXIT_PLAN_PROMPT_SNIPPET,
		promptGuidelines: EXIT_PLAN_PROMPT_GUIDELINES,
		parameters: ExitPlanParamsSchema,
		executionMode: "sequential" as ToolExecutionMode,
		rendersOwnProgress: true,

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
			return renderExitPlanCall(args, theme, context.expanded);
		},

		renderResult(result, _options, theme) {
			return new Text(formatExitPlanResult(result, theme), 0, 0);
		},
	});

	/**
	 * Plans offered in the /plan panel: this branch's plans first (newest
	 * first), then the rest of the project's, deduped, bounded. Legacy plans
	 * from other sessions' directories only appear via planFiles entries.
	 */
	function collectPanelPlanFiles(ctx: ExtensionContext): string[] {
		const state = getPlanState();
		const seen = new Set<string>();
		const files: string[] = [];
		for (const path of [...[...state.planFiles].reverse(), ...listProjectPlanFiles(ctx.cwd)]) {
			const key = path.replace(/\\/g, "/").toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			files.push(path);
			if (files.length >= PLAN_PANEL_MAX_FILES) break;
		}
		return files;
	}

	/** Panel behind /plan while planning: pick a plan file or exit the mode. */
	async function openPlanPanel(ctx: ExtensionContext): Promise<void> {
		const files = collectPanelPlanFiles(ctx);
		const fileOptions = files.map((path) => ({ label: basename(path), description: shortenPlanPath(path) }));
		const options = [{ label: PLAN_PANEL_EXIT, description: PLAN_PANEL_EXIT_DESCRIPTION }, ...fileOptions];
		const choice = await ctx.ui.select(PLAN_PANEL_TITLE, options, { cancelHint: PLAN_PANEL_CANCEL_HINT });
		if (choice === PLAN_PANEL_EXIT) {
			exitPlanMode(ctx, "Plan mode disabled: full tool access restored.");
			return;
		}
		if (!choice) return; // Esc: keep planning, no side effects.
		const selected = files.find((path) => basename(path) === choice);
		if (selected) ctx.ui.pasteToEditor(selected);
	}

	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Enter plan mode; while planning, open the plan panel (pick a plan file or exit)",
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
			if (!state.planning) {
				enterPlanMode(ctx);
				return;
			}
			if (ctx.mode !== "tui") {
				// No panel affordances outside the TUI: keep the toggle semantic.
				exitPlanMode(ctx, "Plan mode disabled: full tool access restored.");
				return;
			}
			await openPlanPanel(ctx);
		},
	});

	// Defense in depth: the active-tools change lands on the next LLM request,
	// so a request already in flight when plan mode toggled can still carry
	// blocked tool calls.
	pi.on("tool_call", async (event, ctx) => {
		setActivePlanSession(ctx.sessionManager.getSessionId());
		const state = getPlanState();
		if (!state.planning) return;
		if (PLAN_BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is disabled. Keep exploring with read-only tools, or call ${EXIT_PLAN_TOOL_NAME} to submit the plan for approval.`,
			};
		}
		if (event.toolName === PLAN_SUBAGENT_TOOL_NAME) {
			const disallowed = findDisallowedSubagentProfile(event.input);
			if (disallowed !== undefined) {
				return {
					block: true,
					reason: `Plan mode: subagent profile "${disallowed}" is blocked while planning. Delegate read-only exploration with agent: "${PLAN_ALLOWED_SUBAGENT}" (set it on every task in tasks mode).`,
				};
			}
		}
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
