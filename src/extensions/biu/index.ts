/**
 * biu — a structured development workflow (interview -> decompose -> execute
 * -> archive) modeled after Plan Mode.
 *
 * /biu toggles Biu Mode on; inside the mode, /biu opens the management menu.
 * Workflow state lives in biu.json under the Pi agent directory and changes
 * only through the `biu` tool; the tool is added to the active tool set while
 * the mode is on and removed when it is off. Only a short resident block is
 * injected into the system prompt each turn — stage playbooks are pulled on
 * demand via the tool's "get" action.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { isStaleExtensionContextError } from "../../core/extensions/types.ts";
import {
	buildBiuFreshWorkspacePrompt,
	buildBiuKickoffContent,
	buildBiuResidentPrompt,
	buildBiuStateErrorPrompt,
	formatBiuStatusLine,
} from "./prompts.ts";
import { renderBiuCall, renderBiuKickoffMessage, renderBiuResult } from "./render.ts";
import {
	BIU_STAGES,
	type BiuStage,
	type BiuState,
	ensureBiuWorkspace,
	findActiveTask,
	findNextTask,
	getBiuPaths,
	getStageTransitionError,
	getTaskCounts,
	loadBiuState,
	saveBiuState,
} from "./state.ts";
import { BIU_TOOL_NAME, createBiuTool } from "./tool.ts";

export const BIU_COMMAND_NAME = "biu";
export const BIU_MODE_ENTRY_TYPE = "biu-mode";
export const BIU_KICKOFF_MESSAGE_TYPE = "biu-kickoff";
export const BIU_STATUS_KEY = "biu";
export const BIU_MODE_SCHEMA_VERSION = 1;

interface BiuModeEntryData {
	schemaVersion: number;
	enabled: boolean;
}

export interface BiuKickoffDetails {
	schemaVersion: number;
	stage: BiuStage;
}

function isBiuModeEntryData(value: unknown): value is BiuModeEntryData {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === BIU_MODE_SCHEMA_VERSION && typeof record.enabled === "boolean";
}

/** Replay the latest Biu Mode flag from a session branch. */
export function replayBiuMode(entries: Iterable<unknown>): boolean {
	const branch = Array.from(entries);
	for (let index = branch.length - 1; index >= 0; index--) {
		const candidate = branch[index];
		if (!candidate || typeof candidate !== "object") continue;
		const entry = candidate as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== BIU_MODE_ENTRY_TYPE) continue;
		if (isBiuModeEntryData(entry.data)) return entry.data.enabled;
	}
	return false;
}

function truncate(text: string, maxLength: number): string {
	const inline = text.replace(/\s+/g, " ").trim();
	return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`;
}

function describeFocusLine(state: BiuState): string | undefined {
	const active = findActiveTask(state);
	if (active) return `Active: ${active.id} · ${truncate(active.title, 80)}`;
	const next = findNextTask(state);
	if (next) return `Next: ${next.id} · ${truncate(next.title, 80)}`;
	return undefined;
}

function formatDetailedStatus(state: BiuState, workspace: string): string {
	const counts = getTaskCounts(state);
	const lines = [
		formatBiuStatusLine(state),
		`Workspace: ${workspace}`,
		`SPEC: ${state.spec.status}${state.spec.title ? ` · ${truncate(state.spec.title, 80)}` : ""}`,
		`Tasks: ${counts.total} total · ${counts.ready} ready · ${counts.inProgress} in progress · ${counts.completed} completed`,
	];
	const focus = describeFocusLine(state);
	if (focus) lines.push(focus);
	return lines.join("\n");
}

export default function biuExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function persistMode(nextEnabled: boolean): void {
		pi.appendEntry(BIU_MODE_ENTRY_TYPE, { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: nextEnabled });
	}

	/** Keep the biu tool visible to the model only while Biu Mode is on. */
	function syncActiveTools(): void {
		const active = pi.getActiveTools();
		const hasTool = active.includes(BIU_TOOL_NAME);
		if (enabled && !hasTool) pi.setActiveTools([...active, BIU_TOOL_NAME]);
		else if (!enabled && hasTool) pi.setActiveTools(active.filter((name) => name !== BIU_TOOL_NAME));
	}

	function setStatus(ctx: ExtensionContext, state: BiuState | undefined, error?: string): void {
		if (!enabled) {
			ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
			return;
		}
		if (state) {
			const color = state.stage === "archive" ? "success" : "accent";
			ctx.ui.setStatus(BIU_STATUS_KEY, ctx.ui.theme.fg(color, formatBiuStatusLine(state)));
		} else {
			ctx.ui.setStatus(BIU_STATUS_KEY, ctx.ui.theme.fg("warning", error ? "Biu · state error" : "Biu"));
		}
	}

	async function refreshStatusFromDisk(ctx: ExtensionContext): Promise<void> {
		try {
			const state = await loadBiuState(ctx.cwd);
			setStatus(ctx, state);
		} catch (error) {
			if (isStaleExtensionContextError(error)) return;
			try {
				setStatus(ctx, undefined, error instanceof Error ? error.message : String(error));
			} catch (statusError) {
				if (!isStaleExtensionContextError(statusError)) throw statusError;
			}
		}
	}

	function disableMode(ctx: ExtensionContext): void {
		enabled = false;
		persistMode(false);
		syncActiveTools();
		ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
		ctx.ui.notify("Biu Mode off. Workflow files were kept.", "info");
	}

	function sendKickoff(state: BiuState): void {
		pi.sendMessage(
			{
				customType: BIU_KICKOFF_MESSAGE_TYPE,
				content: buildBiuKickoffContent(state),
				display: true,
				details: { schemaVersion: BIU_MODE_SCHEMA_VERSION, stage: state.stage } satisfies BiuKickoffDetails,
			},
			{ triggerTurn: true },
		);
	}

	async function switchStageFromMenu(ctx: ExtensionCommandContext, state: BiuState): Promise<void> {
		const options = BIU_STAGES.map((stage) => ({
			label: stage === state.stage ? `${stage} (current)` : stage,
			description:
				stage === "interview"
					? "Clarify requirements into SPEC.md"
					: stage === "decompose"
						? "Break the ready SPEC into task handoffs"
						: stage === "execute"
							? "Implement tasks one at a time"
							: "Summarize and close the cycle",
		}));
		const choice = await ctx.ui.select("Switch Biu stage", options, {
			subtitle: formatBiuStatusLine(state),
			cancelHint: "keep the current stage",
		});
		if (!choice) return;
		const target = choice.replace(" (current)", "") as BiuStage;
		const error = getStageTransitionError(state, target);
		if (error) {
			ctx.ui.notify(error, "warning");
			return;
		}
		state.stage = target;
		state.updatedAt = new Date().toISOString();
		await saveBiuState(ctx.cwd, state);
		setStatus(ctx, state);
		ctx.ui.notify(`Biu stage switched to ${target}.`, "info");
	}

	async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("The Biu menu requires an interactive UI.", "warning");
			return;
		}

		let state: BiuState | undefined;
		try {
			state = (await ensureBiuWorkspace(ctx.cwd)).state;
		} catch (error) {
			if (isStaleExtensionContextError(error)) return;
			const message = error instanceof Error ? error.message : String(error);
			const choice = await ctx.ui.select("Biu Mode", ["Exit Biu Mode"], {
				subtitle: truncate(`State error: ${message}`, 120),
				cancelHint: "keep Biu Mode active",
			});
			if (choice === "Exit Biu Mode") disableMode(ctx);
			return;
		}
		setStatus(ctx, state);

		const focus = describeFocusLine(state);
		const continueLabel = `Continue · ${state.stage}`;
		const choice = await ctx.ui.select(
			"Biu Mode",
			[
				{ label: continueLabel, description: focus ?? "Start a new turn continuing the current stage" },
				{ label: "Show status", description: "Workspace path, SPEC status, and task counts" },
				{ label: "Switch stage…", description: "Move the workflow to another stage" },
				{ label: "Exit Biu Mode", description: "Turn the mode off; workflow files are kept" },
			],
			{ subtitle: formatBiuStatusLine(state), cancelHint: "keep Biu Mode active" },
		);

		if (choice === continueLabel) {
			sendKickoff(state);
		} else if (choice === "Show status") {
			ctx.ui.notify(formatDetailedStatus(state, getBiuPaths(ctx.cwd).root), "info");
		} else if (choice === "Switch stage…") {
			await switchStageFromMenu(ctx, state);
		} else if (choice === "Exit Biu Mode") {
			disableMode(ctx);
		}
	}

	async function syncFromBranch(ctx: ExtensionContext): Promise<void> {
		try {
			enabled = replayBiuMode(ctx.sessionManager.getBranch());
			syncActiveTools();
			if (enabled) await refreshStatusFromDisk(ctx);
			else ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	const tool = createBiuTool({ isEnabled: () => enabled });
	pi.registerTool({
		...tool,
		renderCall: (args, theme) => renderBiuCall(args, theme),
		renderResult: (result, options, theme, context) => renderBiuResult(result, options, theme, context),
	});

	pi.registerMessageRenderer<BiuKickoffDetails>(BIU_KICKOFF_MESSAGE_TYPE, renderBiuKickoffMessage);

	pi.registerCommand(BIU_COMMAND_NAME, {
		description: "Toggle Biu Mode; inside the mode, open the Biu menu",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /biu (no arguments)", "warning");
				return;
			}

			await ctx.waitForIdle();

			if (enabled) {
				await openMenu(ctx);
				return;
			}

			let workspace: Awaited<ReturnType<typeof ensureBiuWorkspace>>;
			try {
				workspace = await ensureBiuWorkspace(ctx.cwd);
			} catch (error) {
				if (isStaleExtensionContextError(error)) return;
				ctx.ui.notify(
					`Unable to open the Biu workspace: ${truncate(error instanceof Error ? error.message : String(error), 300)}`,
					"error",
				);
				return;
			}

			enabled = true;
			persistMode(true);
			syncActiveTools();
			setStatus(ctx, workspace.state);

			const fresh =
				workspace.state.stage === "interview" && workspace.state.tasks.length === 0 && !workspace.state.spec.title;
			if (fresh) {
				ctx.ui.notify("Biu Mode on · interview — describe what you want to build to start the interview.", "info");
			} else {
				const focus = describeFocusLine(workspace.state);
				ctx.ui.notify(
					`Biu Mode on · ${formatBiuStatusLine(workspace.state)}${focus ? `\n${focus}` : ""}\nUse /biu for the menu.`,
					"info",
				);
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		let block: string;
		try {
			const state = await loadBiuState(ctx.cwd);
			block = state ? buildBiuResidentPrompt(state) : buildBiuFreshWorkspacePrompt();
		} catch (error) {
			if (isStaleExtensionContextError(error)) return;
			block = buildBiuStateErrorPrompt(error instanceof Error ? error.message : String(error));
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== BIU_TOOL_NAME || event.isError || !enabled) return;
		await refreshStatusFromDisk(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await syncFromBranch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		enabled = false;
		try {
			ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});
}
