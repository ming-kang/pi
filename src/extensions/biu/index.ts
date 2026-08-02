/**
 * biu — a structured development workflow (plan -> optional decompose ->
 * execute -> archive) modeled after Plan Mode.
 *
 * /biu toggles Biu Mode on; inside the mode, /biu opens the management menu.
 * Workflow state lives in the frontmatter of the workspace Markdown files
 * under the Pi agent directory; the extension only derives a read-only
 * snapshot from them. The model addresses those files through the biu://
 * scheme, which a tool_call hook resolves to the real workspace paths, so
 * read/write/edit/grep/find/ls work on them with short, stable paths.
 * Archiving a cycle is deterministic and menu-driven, never model-driven.
 */
import { readFile } from "node:fs/promises";
import { sep } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderOptions,
} from "../../core/extensions/types.ts";
import { isStaleExtensionContextError } from "../../core/extensions/types.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	buildBiuKickoffContent,
	buildBiuResidentPrompt,
	buildBiuWorkspaceErrorPrompt,
	describeBiuFocus,
	formatBiuStatusLine,
} from "./prompts.ts";
import {
	archiveBiuCycle,
	type BiuSnapshot,
	type BiuStage,
	detectSpecReadyTransition,
	ensureBiuWorkspace,
	getBiuPaths,
	isBiuUri,
	loadBiuSnapshot,
	resolveBiuUri,
	sanitizeShortname,
} from "./workspace.ts";

export const BIU_COMMAND_NAME = "biu";
export const BIU_MODE_ENTRY_TYPE = "biu-mode";
export const BIU_KICKOFF_MESSAGE_TYPE = "biu-kickoff";
export const BIU_STATUS_KEY = "biu";
export const BIU_MODE_SCHEMA_VERSION = 2;

const BIU_TUI_ONLY_MESSAGE = "Biu Mode is available only in interactive TUI mode.";

/** Core tools whose `path` argument understands the biu:// scheme. */
const BIU_PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

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
	return typeof record.schemaVersion === "number" && typeof record.enabled === "boolean";
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

function isInsideWorkspace(absolutePath: string, root: string): boolean {
	return absolutePath === root || absolutePath.startsWith(`${root}${sep}`);
}

function expandHint(theme: Theme): string {
	return `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

export function renderBiuKickoffMessage(
	message: CustomMessage<BiuKickoffDetails>,
	options: MessageRenderOptions,
	theme: Theme,
) {
	const content = typeof message.content === "string" ? message.content : "";
	const stage = message.details?.stage;
	const summary = `Biu · continue${stage ? ` ${stage}` : ""}`;
	if (!options.expanded) {
		return new Text(`${theme.fg("accent", theme.bold(summary))}${expandHint(theme)}`, options.outputPad, 0);
	}
	const container = new Container();
	container.addChild(new Text(theme.fg("accent", theme.bold(summary)), options.outputPad, 0));
	container.addChild(new Text(theme.fg("muted", content), options.outputPad, 0));
	return container;
}

export default function biuExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function persistMode(nextEnabled: boolean): void {
		pi.appendEntry(BIU_MODE_ENTRY_TYPE, { schemaVersion: BIU_MODE_SCHEMA_VERSION, enabled: nextEnabled });
	}

	function setStatus(ctx: ExtensionContext, snapshot: BiuSnapshot | undefined, error?: string): void {
		if (ctx.mode !== "tui") return;
		if (!enabled) {
			ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
			return;
		}
		if (snapshot) {
			const color = snapshot.problems.length > 0 ? "warning" : snapshot.stage === "archive" ? "success" : "accent";
			ctx.ui.setStatus(BIU_STATUS_KEY, ctx.ui.theme.fg(color, formatBiuStatusLine(snapshot)));
		} else {
			ctx.ui.setStatus(BIU_STATUS_KEY, ctx.ui.theme.fg("warning", error ? "Biu · workspace error" : "Biu"));
		}
	}

	async function refreshStatusFromDisk(ctx: ExtensionContext): Promise<void> {
		try {
			setStatus(ctx, await loadBiuSnapshot(ctx.cwd));
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
		setStatus(ctx, undefined);
		ctx.ui.notify("Biu Mode off. Workflow files were kept.", "info");
	}

	function sendKickoff(snapshot: BiuSnapshot): void {
		pi.sendMessage(
			{
				customType: BIU_KICKOFF_MESSAGE_TYPE,
				content: buildBiuKickoffContent(snapshot),
				display: true,
				details: { schemaVersion: BIU_MODE_SCHEMA_VERSION, stage: snapshot.stage } satisfies BiuKickoffDetails,
			},
			{ triggerTurn: true },
		);
	}

	/** Menu-driven, deterministic cycle close: confirm, name, move, report. */
	async function archiveFromMenu(ctx: ExtensionCommandContext, snapshot: BiuSnapshot): Promise<void> {
		if (!snapshot.spec.exists || !snapshot.summaryExists) {
			ctx.ui.notify(
				"Archiving needs both biu://SPEC.md and a confirmed biu://Summary.md. Ask the agent to draft the summary first (archive stage).",
				"warning",
			);
			return;
		}
		const unfinished = snapshot.tasks.filter((task) => task.status !== "completed");
		if (unfinished.length > 0) {
			const proceed = await ctx.ui.confirm(
				"Archive with unfinished tasks?",
				`${unfinished.length} task(s) are not completed: ${truncate(unfinished.map((task) => task.id).join(", "), 200)}`,
			);
			if (!proceed) return;
		}
		let shortname = snapshot.spec.title ? sanitizeShortname(snapshot.spec.title) : "";
		if (!shortname) {
			const answer = await ctx.ui.input("Archive name", "short, filesystem-safe name for the archived cycle");
			if (!answer?.trim()) {
				ctx.ui.notify("Archive cancelled: no name given.", "info");
				return;
			}
			shortname = answer.trim();
		}
		try {
			const result = await archiveBiuCycle(ctx.cwd, shortname);
			await refreshStatusFromDisk(ctx);
			ctx.ui.notify(`Cycle archived to ${result.archivedPath}. A fresh cycle starts at the plan stage.`, "info");
		} catch (error) {
			if (isStaleExtensionContextError(error)) return;
			ctx.ui.notify(
				`Archive failed: ${truncate(error instanceof Error ? error.message : String(error), 300)}`,
				"error",
			);
		}
	}

	async function openMenu(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(BIU_TUI_ONLY_MESSAGE, "warning");
			return;
		}

		let snapshot: BiuSnapshot;
		try {
			await ensureBiuWorkspace(ctx.cwd);
			snapshot = await loadBiuSnapshot(ctx.cwd);
		} catch (error) {
			if (isStaleExtensionContextError(error)) return;
			const message = error instanceof Error ? error.message : String(error);
			const choice = await ctx.ui.select("Biu Mode", ["Exit Biu Mode"], {
				subtitle: truncate(`Workspace error: ${message}`, 120),
				cancelHint: "keep Biu Mode active",
			});
			if (choice === "Exit Biu Mode") disableMode(ctx);
			return;
		}
		setStatus(ctx, snapshot);

		const subtitleParts = [formatBiuStatusLine(snapshot)];
		if (snapshot.problems.length > 0) subtitleParts.push(`${snapshot.problems.length} problem(s)`);
		const continueLabel = `Continue · ${snapshot.stage}`;
		const choice = await ctx.ui.select(
			"Biu Mode",
			[
				{ label: continueLabel, description: truncate(describeBiuFocus(snapshot), 80) },
				{ label: "Archive cycle", description: "Move SPEC.md, Summary.md, and tasks/ into archived/" },
				{ label: "Exit Biu Mode", description: "Turn the mode off; workflow files are kept" },
			],
			{ subtitle: subtitleParts.join(" · "), cancelHint: "keep Biu Mode active" },
		);

		if (choice === continueLabel) {
			sendKickoff(snapshot);
		} else if (choice === "Archive cycle") {
			await archiveFromMenu(ctx, snapshot);
		} else if (choice === "Exit Biu Mode") {
			disableMode(ctx);
		}
	}

	async function syncFromBranch(ctx: ExtensionContext): Promise<void> {
		try {
			if (ctx.mode !== "tui") {
				enabled = false;
				return;
			}
			enabled = replayBiuMode(ctx.sessionManager.getBranch());
			if (enabled) await refreshStatusFromDisk(ctx);
			else ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	pi.registerMessageRenderer<BiuKickoffDetails>(BIU_KICKOFF_MESSAGE_TYPE, renderBiuKickoffMessage);

	pi.registerCommand(BIU_COMMAND_NAME, {
		description: "Toggle Biu Mode; inside the mode, open the Biu menu",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(BIU_TUI_ONLY_MESSAGE, "warning");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /biu (no arguments)", "warning");
				return;
			}

			await ctx.waitForIdle();

			if (enabled) {
				await openMenu(ctx);
				return;
			}

			let snapshot: BiuSnapshot;
			try {
				await ensureBiuWorkspace(ctx.cwd);
				snapshot = await loadBiuSnapshot(ctx.cwd);
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
			setStatus(ctx, snapshot);

			const fresh = !snapshot.spec.exists && snapshot.tasks.length === 0 && !snapshot.summaryExists;
			if (fresh) {
				ctx.ui.notify("Biu Mode on · plan — describe what you want to build to start the interview.", "info");
			} else {
				ctx.ui.notify(
					`Biu Mode on · ${formatBiuStatusLine(snapshot).replace(/^Biu · /, "")}\n${describeBiuFocus(snapshot)}\nUse /biu for the menu.`,
					"info",
				);
			}
		},
	});

	// Resolve biu:// paths for the core file tools. Always active: the scheme is
	// deterministic and harmless outside Biu Mode, and rewriting only happens on
	// explicit biu:// arguments. The session keeps the model's original biu://
	// arguments; only execution sees the resolved absolute path.
	pi.on("tool_call", async (event, ctx) => {
		if (!BIU_PATH_TOOLS.has(event.toolName)) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return;
		if (isBiuUri(input.path)) {
			const resolution = resolveBiuUri(input.path, ctx.cwd);
			if (!resolution.ok) return { block: true, reason: resolution.reason };
			input.path = resolution.path;
		}

		// Approval gate: flipping the SPEC's frontmatter status to ready needs the
		// user's explicit sign-off (the Biu analogue of ExitPlanMode approval).
		// The gate is a guardrail, not a sandbox: on any internal failure it steps
		// aside and lets the write proceed.
		if (!enabled || ctx.mode !== "tui") return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		try {
			if (input.path !== getBiuPaths(ctx.cwd).specFile) return;
			const current = await readFile(input.path, "utf8").catch(() => null);
			if (!detectSpecReadyTransition(current, event.toolName, event.input as Record<string, unknown>)) return;
			const approved = await ctx.ui.confirm(
				"Approve SPEC?",
				"The agent wants to mark biu://SPEC.md as ready. Approving moves the cycle to the execute stage.",
			);
			if (approved) return;
			const feedback = await ctx.ui.input("Feedback", "why it was declined (sent to the agent)");
			const feedbackNote = feedback?.trim() ? ` Feedback: ${feedback.trim()}.` : "";
			return {
				block: true,
				reason: `The user declined to approve the SPEC as ready.${feedbackNote} Revise biu://SPEC.md accordingly, keep status: draft, and ask again when ready.`,
			};
		} catch {
			// A gate failure must never block a legitimate write.
			return;
		}
	});

	// Frontmatter edits through write/edit are the only workflow state changes;
	// refresh the statusline whenever one lands inside the workspace.
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || ctx.mode !== "tui" || event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return;
		try {
			if (!isInsideWorkspace(input.path, getBiuPaths(ctx.cwd).root)) return;
			await refreshStatusFromDisk(ctx);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || ctx.mode !== "tui") return;
		let block: string;
		try {
			block = buildBiuResidentPrompt(await loadBiuSnapshot(ctx.cwd));
		} catch (error) {
			if (isStaleExtensionContextError(error)) return;
			block = buildBiuWorkspaceErrorPrompt(error instanceof Error ? error.message : String(error));
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		await syncFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await syncFromBranch(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		enabled = false;
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});
}
