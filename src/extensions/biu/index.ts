import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { isStaleExtensionContextError } from "../../core/extensions/types.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { buildBiuScanFailurePrompt, buildBiuSystemPrompt } from "./prompts.ts";
import { type BiuWorkspaceSnapshot, ensureBiuWorkspace, getBiuWorkspacePaths, scanBiuWorkspace } from "./storage.ts";

export const BIU_COMMAND_NAME = "biu";
export const BIU_MODE_ENTRY_TYPE = "biu-mode";
export const BIU_KICKOFF_MESSAGE_TYPE = "biu-kickoff";
export const BIU_STATUS_KEY = "biu";
export const BIU_MODE_SCHEMA_VERSION = 1;

interface BiuModeEntryData {
	schemaVersion: number;
	enabled: boolean;
}

interface RefreshResult {
	snapshot?: BiuWorkspaceSnapshot;
	workspacePath: string;
	error?: string;
	stale?: boolean;
}

function isBiuModeEntryData(value: unknown): value is BiuModeEntryData {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.schemaVersion === BIU_MODE_SCHEMA_VERSION && typeof record.enabled === "boolean";
}

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

function bounded(value: string, maximum: number): string {
	const inline = stripAnsi(value).replace(/\s+/g, " ").trim();
	return inline.length <= maximum ? inline : `${inline.slice(0, maximum - 1)}…`;
}

function plainStatus(snapshot: BiuWorkspaceSnapshot): string {
	if (snapshot.stage === "execute" || snapshot.stage === "archive") {
		return `Biu · ${snapshot.stage} ${snapshot.taskCounts.completed}/${snapshot.taskCounts.total}`;
	}
	if (snapshot.stage === "decompose" && snapshot.missingAcceptanceCriteria.length > 0) {
		return `Biu · decompose (${snapshot.missingAcceptanceCriteria.length} AC missing)`;
	}
	return `Biu · ${snapshot.stage}`;
}

function setSnapshotStatus(ctx: ExtensionContext, snapshot: BiuWorkspaceSnapshot): void {
	const color = snapshot.stage === "repair" ? "warning" : snapshot.stage === "archive" ? "success" : "accent";
	ctx.ui.setStatus(BIU_STATUS_KEY, ctx.ui.theme.fg(color, plainStatus(snapshot)));
}

function clearStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(BIU_STATUS_KEY, undefined);
}

function formatSnapshot(snapshot: BiuWorkspaceSnapshot): string {
	const lines = [
		plainStatus(snapshot),
		`Workspace: ${bounded(snapshot.paths.root, 300)}`,
		`SPEC: ${snapshot.specStatus ?? "missing"}${snapshot.specTitle ? ` · ${bounded(snapshot.specTitle, 120)}` : ""}`,
		`Tasks: ${snapshot.taskCounts.total} total · ${snapshot.taskCounts.ready} ready · ${snapshot.taskCounts.inProgress} in progress · ${snapshot.taskCounts.completed} completed`,
	];
	if (snapshot.activeTask)
		lines.push(`Active: ${bounded(snapshot.activeTask.id, 100)} · ${bounded(snapshot.activeTask.title, 120)}`);
	else if (snapshot.nextTask)
		lines.push(`Next: ${bounded(snapshot.nextTask.id, 100)} · ${bounded(snapshot.nextTask.title, 120)}`);
	if (snapshot.missingAcceptanceCriteria.length > 0) {
		lines.push(`Missing AC coverage: ${snapshot.missingAcceptanceCriteria.slice(0, 20).join(", ")}`);
	}
	if (snapshot.issues.length > 0) {
		lines.push("Issues:");
		for (const issue of snapshot.issues.slice(0, 5)) lines.push(`- ${bounded(issue, 240)}`);
		if (snapshot.issues.length > 5) lines.push(`- ${snapshot.issues.length - 5} more issue(s)`);
	}
	return lines.join("\n");
}

export default function biuExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function persistMode(nextEnabled: boolean): void {
		pi.appendEntry(BIU_MODE_ENTRY_TYPE, {
			schemaVersion: BIU_MODE_SCHEMA_VERSION,
			enabled: nextEnabled,
		});
	}

	async function refresh(ctx: ExtensionContext, updateStatus = true): Promise<RefreshResult> {
		let workspacePath = "<unavailable>";
		try {
			workspacePath = getBiuWorkspacePaths(ctx.cwd).root;
			if (updateStatus) await ensureBiuWorkspace(ctx.cwd);
			const snapshot = await scanBiuWorkspace(ctx.cwd);
			if (updateStatus) setSnapshotStatus(ctx, snapshot);
			return { snapshot, workspacePath };
		} catch (error) {
			if (isStaleExtensionContextError(error)) return { workspacePath, stale: true };
			const message = error instanceof Error ? error.message : String(error);
			if (updateStatus) {
				try {
					ctx.ui.setStatus(BIU_STATUS_KEY, ctx.ui.theme.fg("warning", "Biu · repair"));
				} catch (statusError) {
					if (isStaleExtensionContextError(statusError)) return { workspacePath, stale: true };
					throw statusError;
				}
			}
			return { workspacePath, error: message };
		}
	}

	async function syncFromBranch(ctx: ExtensionContext): Promise<void> {
		try {
			enabled = replayBiuMode(ctx.sessionManager.getBranch());
			if (enabled) await refresh(ctx);
			else clearStatus(ctx);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	pi.registerCommand(BIU_COMMAND_NAME, {
		description: "Enter or resume the project Biu workflow",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "status", label: "status", description: "Show the inferred stage and workspace" },
				{ value: "off", label: "off", description: "Leave Biu Mode without changing workflow files" },
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "" && action !== "status" && action !== "off") {
				ctx.ui.notify("Usage: /biu [status|off]", "warning");
				return;
			}

			await ctx.waitForIdle();

			if (action === "off") {
				enabled = false;
				persistMode(false);
				clearStatus(ctx);
				ctx.ui.notify("Biu Mode disabled. Workflow files were left unchanged.", "info");
				return;
			}

			if (action === "status") {
				const current = await refresh(ctx, enabled);
				if (current.snapshot) {
					ctx.ui.notify(
						formatSnapshot(current.snapshot),
						current.snapshot.stage === "repair" ? "warning" : "info",
					);
				} else if (current.error) {
					ctx.ui.notify(`Biu scan failed: ${bounded(current.error, 500)}`, "error");
				}
				return;
			}

			try {
				await ensureBiuWorkspace(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(
					`Unable to create Biu workspace: ${bounded(error instanceof Error ? error.message : String(error), 500)}`,
					"error",
				);
				return;
			}

			if (!enabled) {
				enabled = true;
				persistMode(true);
			}
			const current = await refresh(ctx);
			if (current.snapshot) {
				ctx.ui.notify(`${plainStatus(current.snapshot)}\n${bounded(current.snapshot.paths.root, 300)}`, "info");
			} else if (current.error) {
				ctx.ui.notify(`Biu scan failed: ${bounded(current.error, 500)}`, "error");
			}

			pi.sendMessage(
				{
					customType: BIU_KICKOFF_MESSAGE_TYPE,
					content:
						"For this turn only, continue the current Biu stage when Biu Mode instructions are active in the system prompt; otherwise ignore this message.",
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		const current = await refresh(ctx);
		if (current.stale) return;
		const biuPrompt = current.snapshot
			? buildBiuSystemPrompt(current.snapshot)
			: buildBiuScanFailurePrompt(current.workspacePath, current.error ?? "unknown workspace scan error");
		return { systemPrompt: `${event.systemPrompt}\n\n${biuPrompt}` };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (enabled) await refresh(ctx);
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
			clearStatus(ctx);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});
}
