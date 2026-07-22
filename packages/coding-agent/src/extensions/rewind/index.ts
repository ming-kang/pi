/**
 * rewind — file-backed checkpoint & rewind for Pi.
 *
 * Engine: instead of snapshotting the whole work tree into a per-session shadow
 * git repo (the old design, which froze the UI in large directories like a
 * multi-project parent folder and grew storage without bound), we back up ONLY
 * the files Pi's edit/write tools are about to modify — one copyFile before each
 * edit (see engine.ts, ported from Claude Code's file-history). Cost is
 * proportional to how many files Pi changed, never to project size.
 *
 * Per turn: before_agent_start opens a snapshot frame (re-recording tracked files
 * at their turn-start state); tool_call(edit|write) backs up each newly edited
 * file before it lands; agent_settled persists the frame to the session JSONL
 * (custom "pi-rewind-snapshot" entry) when it changed. agent_settled is used
 * instead of agent_end so auto-retry, overflow compaction-retry, and queued
 * follow-ups stay in one logical turn (agent_end can fire mid-continuation).
 * On session_start the index is rebuilt from those entries; resume/fork
 * hard-links the prior session's blobs.
 *
 * Time-travel is fused into /tree: navigating to a node whose turn changed files
 * offers to sync the work tree to that point (session_before_tree/session_tree).
 * /rewind itself is a settings + storage menu (menu.ts), not a restore picker.
 *
 * Restore safety: applySnapshot only rewrites files that differ and never throws
 * out — a broken backup degrades to "leave the file alone", so it can never abort
 * the user's session.
 *
 * Architecture informed by oh-my-pi (GPL-3.0) and Claude Code's file-history;
 * independent implementation. No ANSI: all UI is native (ctx.ui.* + theme).
 */
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";

import { loadRewindConfig, type RewindConfig, reloadRewindConfig } from "./config.ts";
import {
	beginTurn,
	disposeSession,
	endTurn,
	getSnapshots,
	migrateBackupsFromSession,
	registerSession,
	restoreStateFromSnapshots,
	trackEdit,
} from "./engine.ts";
import { runGc, sessionIdFromFile } from "./gc.ts";
import { runRewindMenu } from "./menu.ts";
import { rewindBackupsRoot, sessionsDirectory } from "./paths.ts";
import { restoreToSnapshot, snapshotChangeDiffStats, snapshotChangedPaths, snapshotForEntry } from "./restore.ts";
import { type FileHistorySnapshot, isSnapshot, SNAPSHOT_ENTRY_TYPE } from "./snapshot.ts";
import { configureStorage } from "./storage.ts";
import { truncateText } from "./text.ts";
import { editWriteTargetPath, resolveToolPath } from "./tool-path.ts";

// Bind the engine/gc storage roots to the real on-disk locations (they avoid
// importing paths.ts directly so they stay node-testable). Safe to call at load.
configureStorage({ backupsRoot: rewindBackupsRoot(), sessionsRoot: sessionsDirectory() });

// Global (one config.json). Reloaded from disk at session_start; /rewind menu
// saveRewindConfig updates the in-memory cache so the next turn sees changes
// without re-reading the file every before_agent_start.
let config: RewindConfig = loadRewindConfig();

/** /tree confirm → apply payload (changedPaths skips a second originChanged pass). */
interface PendingTreeRestore {
	snapshot: FileHistorySnapshot;
	changedPaths: string[];
}

// Per-session transient state held by the integration layer.
const pendingPrompt = new Map<string, string>(); // turn prompt, captured for the snapshot label
const pendingTreeRestore = new Map<string, PendingTreeRestore | null>(); // /tree sync intent

// ---- helpers --------------------------------------------------------------

/** The id of the last user message in the current branch (the turn's anchor). */
function lastUserEntryId(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "message" && (e.message as AgentMessage).role === "user") return e.id;
	}
	return undefined;
}

/** Rebuild the snapshot list for a session from its persisted custom entries. */
function rebuildSnapshots(ctx: ExtensionContext): FileHistorySnapshot[] {
	const out: FileHistorySnapshot[] = [];
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE && isSnapshot(entry.data)) {
			out.push(entry.data);
		}
	}
	return out;
}

/** Max files listed in the /tree restore confirmation before "+N more". */
const RESTORE_PREVIEW_LIMIT = 8;
/** Max characters per previewed path (leading-truncated: the filename matters most). */
const RESTORE_PREVIEW_PATH_MAX = 64;

/**
 * Bounded cwd-relative file list shown under the /tree restore question, so an
 * irreversible work-tree rewrite is confirmed against WHICH files, not just a
 * count. Multi-line select titles are upstream-sanctioned (ui.confirm joins
 * title + message with \n through the same selector).
 */
function formatRestorePreview(changedPaths: string[], cwd: string): string {
	const lines = changedPaths.slice(0, RESTORE_PREVIEW_LIMIT).map((p) => {
		const rel = path.relative(cwd, p);
		const display = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
		const bounded =
			display.length > RESTORE_PREVIEW_PATH_MAX ? `…${display.slice(-(RESTORE_PREVIEW_PATH_MAX - 1))}` : display;
		return `  ${bounded}`;
	});
	if (changedPaths.length > RESTORE_PREVIEW_LIMIT) {
		lines.push(`  … +${changedPaths.length - RESTORE_PREVIEW_LIMIT} more`);
	}
	return lines.join("\n");
}

// ---- extension entry ------------------------------------------------------

export default function rewind(pi: ExtensionAPI): void {
	// session_start: rebuild the index, migrate fork/resume blobs, reclaim storage.
	pi.on("session_start", async (event, ctx) => {
		config = reloadRewindConfig();
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		registerSession(sid, ctx.cwd);

		const snapshots = rebuildSnapshots(ctx);
		restoreStateFromSnapshots(sid, ctx.cwd, snapshots, config.maxSnapshots);

		if ((event.reason === "resume" || event.reason === "fork") && event.previousSessionFile) {
			const prevSid = sessionIdFromFile(event.previousSessionFile);
			if (prevSid) {
				try {
					await migrateBackupsFromSession(prevSid, sid, snapshots);
				} catch {
					// best-effort; a missing blob just means that version can't restore
				}
			}
		}

		try {
			runGc(config.retentionDays, sid);
		} catch {
			// GC is best-effort; never block startup
		}
	});

	// tool_call: back up the target file BEFORE the edit/write lands. Synchronous
	// so the backup is on disk before the hook returns control to the agent loop.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (!config.enabled) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		const rawPath = editWriteTargetPath(event.input);
		if (!rawPath) return;
		const abs = resolveToolPath(rawPath, ctx.cwd);
		try {
			trackEdit(sid, abs);
		} catch {
			// never block the edit on a backup failure
		}
	});

	// before_agent_start: open the turn's snapshot frame.
	pi.on("before_agent_start", async (event, ctx) => {
		// Memory-cached; session_start reloads disk, /rewind save updates cache.
		config = loadRewindConfig();
		if (!config.enabled) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		pendingPrompt.set(sid, event.prompt ?? "");
		try {
			await beginTurn(sid);
		} catch {
			// non-fatal
		}
	});

	// agent_settled: finalize + persist after Pi will not auto-continue (retry /
	// compact-retry / follow-up). agent_end alone is too early for that.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!config.enabled) return;
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		const userEntryId = lastUserEntryId(ctx) ?? "";
		const turnId = ctx.sessionManager.getLeafId() ?? userEntryId;
		const prompt = truncateText(pendingPrompt.get(sid) ?? "", 120, { collapseWhitespace: true });
		pendingPrompt.delete(sid);
		const frame = endTurn(sid, userEntryId, turnId, prompt, new Date().toISOString(), config.maxSnapshots);
		if (frame && userEntryId) {
			pi.appendEntry(SNAPSHOT_ENTRY_TYPE, frame);
		}
	});

	// session_before_tree: offer to sync files when navigating to a changed point.
	pi.on("session_before_tree", async (event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		pendingTreeRestore.set(sid, null);
		if (!config.enabled) return;

		const target = snapshotForEntry(getSnapshots(sid), ctx.sessionManager, event.preparation.targetId);
		if (!target) return;
		const changed = await snapshotChangedPaths(sid, target);
		if (changed.length === 0) return; // silent nav, like native /tree
		// Lifecycle handler: silent-return without UI. (hasUI is the guard for
		// ctx.ui.*; checking ctx.mode here would wrongly proceed when a TUI
		// session has no usable UI.)
		if (!ctx.hasUI) return;

		const n = changed.length;
		let lineStats = "";
		try {
			const stats = await snapshotChangeDiffStats(sid, target, changed);
			if (stats.insertions > 0 || stats.deletions > 0) {
				lineStats = `  (+${stats.insertions} / −${stats.deletions})`;
			}
		} catch {
			// Coarse stats are best-effort; still offer path preview.
		}
		const choice = await ctx.ui.select(
			`Restore ${n} file${n === 1 ? "" : "s"} to this point?${lineStats}\n${formatRestorePreview(changed, ctx.cwd)}`,
			["Yes, restore files", "No, conversation only"],
		);
		if (choice?.startsWith("Yes")) {
			// Cache paths so session_tree can apply without a second full compare.
			pendingTreeRestore.set(sid, { snapshot: target, changedPaths: changed });
		}
	});

	// session_tree: execute any sync intent recorded above.
	pi.on("session_tree", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		const pending = pendingTreeRestore.get(sid);
		pendingTreeRestore.set(sid, null);
		if (!pending) return;
		try {
			const changed = await restoreToSnapshot(sid, pending.snapshot, {
				onlyPaths: new Set(pending.changedPaths),
			});
			if (changed.length > 0) {
				ctx.ui.notify(
					`Restored ${changed.length} file${changed.length === 1 ? "" : "s"} to this checkpoint.`,
					"info",
				);
			}
		} catch (e) {
			ctx.ui.notify(`Rewind restore failed: ${String(e)}`, "warning");
		}
	});

	// session_shutdown: drop this session's in-memory state.
	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		if (!sid) return;
		disposeSession(sid);
		pendingTreeRestore.delete(sid);
		pendingPrompt.delete(sid);
	});

	// /rewind: settings + storage menu (time-travel itself is via /tree).
	pi.registerCommand("rewind", {
		description: "Rewind settings and backup storage (restore is via /tree)",
		handler: async (_args, ctx) => {
			await runRewindMenu(ctx);
		},
	});
}
