/**
 * menu.ts — the `/rewind` settings menu.
 *
 * Per the design, /rewind no longer performs the time-travel itself — restoring
 * files is fused into /tree navigation (see index.ts session_before_tree/
 * session_tree). /rewind is purely a settings + storage console:
 *   - toggle the master switch
 *   - set the auto-clean retention window
 *   - inspect and prune backup storage (aged / orphaned / all-but-current)
 */
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";

import { loadRewindConfig, saveRewindConfig } from "./config.ts";
import { listSessions, removeSession, runGc } from "./gc.ts";
import { formatSize } from "./text.ts";

const RETENTION_PRESETS = [7, 14, 30, 60, 90];

export async function runRewindMenu(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/rewind requires an interactive UI.", "warning");
		return;
	}
	const sid = ctx.sessionManager.getSessionId() ?? undefined;

	for (;;) {
		const cfg = loadRewindConfig();
		const sessions = listSessions(sid);
		const total = sessions.reduce((n, s) => n + s.bytes, 0);

		const enabledLabel = `Rewind: ${cfg.enabled ? "on" : "off"}`;
		const retentionLabel = `Auto-clean backups: ${cfg.retentionDays > 0 ? `after ${cfg.retentionDays} days` : "never (keep forever)"}`;
		const storageLabel = `Storage: ${formatSize(total)} across ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;

		const pick = await ctx.ui.select("Rewind settings (Esc to close)", [enabledLabel, retentionLabel, storageLabel]);
		if (!pick) return;

		if (pick === enabledLabel) {
			saveRewindConfig({ ...cfg, enabled: !cfg.enabled });
			ctx.ui.notify(`Rewind ${cfg.enabled ? "disabled" : "enabled"}.`, "info");
		} else if (pick === retentionLabel) {
			await pickRetention(ctx);
		} else if (pick === storageLabel) {
			await storageMenu(ctx, sid);
		}
	}
}

async function pickRetention(ctx: ExtensionCommandContext): Promise<void> {
	const options = [...RETENTION_PRESETS.map((d) => `${d} days`), "Keep forever", "Custom..."];
	const pick = await ctx.ui.select("Auto-clean backups after", options);
	if (!pick) return;

	let days: number;
	if (pick === "Keep forever") {
		days = 0;
	} else if (pick === "Custom...") {
		const value = await ctx.ui.input("Days to keep backups (0 = forever)");
		if (value === undefined) return;
		const n = Number.parseInt(value.trim(), 10);
		if (!Number.isFinite(n) || n < 0) {
			ctx.ui.notify("Invalid number of days.", "warning");
			return;
		}
		days = n;
	} else {
		days = Number.parseInt(pick, 10);
	}

	const cfg = loadRewindConfig();
	saveRewindConfig({ ...cfg, retentionDays: days });
	ctx.ui.notify(days > 0 ? `Backups now kept for ${days} days.` : "Backups kept forever.", "info");
}

async function storageMenu(ctx: ExtensionCommandContext, sid: string | undefined): Promise<void> {
	for (;;) {
		const sessions = listSessions(sid);
		const total = sessions.reduce((n, s) => n + s.bytes, 0);
		const orphans = sessions.filter((s) => s.orphan);
		const others = sessions.filter((s) => s.sessionId !== sid);

		const cleanLabel = "Clean now (aged + orphaned)";
		const orphanLabel = `Remove orphaned (${orphans.length})`;
		const allLabel = `Remove all except current (${others.length})`;

		const pick = await ctx.ui.select(
			`Rewind storage — ${formatSize(total)}, ${sessions.length} session${sessions.length === 1 ? "" : "s"} (Esc to close)`,
			[cleanLabel, orphanLabel, allLabel],
		);
		if (!pick) return;

		if (pick === cleanLabel) {
			const r = runGc(loadRewindConfig().retentionDays, sid);
			ctx.ui.notify(
				r.removed > 0
					? `Removed ${r.removed} session(s), reclaimed ${formatSize(r.reclaimedBytes)}.`
					: "Nothing to clean.",
				"info",
			);
		} else if (pick === orphanLabel) {
			if (orphans.length === 0) {
				ctx.ui.notify("No orphaned backups.", "info");
				continue;
			}
			const ok = await ctx.ui.confirm(
				"Remove orphaned backups?",
				`Deletes backups for ${orphans.length} session(s) with no session file.`,
			);
			if (!ok) continue;
			let bytes = 0;
			let removed = 0;
			for (const s of orphans) {
				const b = removeSession(s.sessionId);
				if (b !== null) {
					bytes += b;
					removed++;
				}
			}
			ctx.ui.notify(`Removed ${removed} orphaned session(s), reclaimed ${formatSize(bytes)}.`, "info");
		} else if (pick === allLabel) {
			if (others.length === 0) {
				ctx.ui.notify("No other sessions' backups.", "info");
				continue;
			}
			const ok = await ctx.ui.confirm(
				"Remove all other backups?",
				`Deletes backups for ${others.length} session(s), keeping only the current session.`,
			);
			if (!ok) continue;
			let bytes = 0;
			let removed = 0;
			for (const s of others) {
				const b = removeSession(s.sessionId);
				if (b !== null) {
					bytes += b;
					removed++;
				}
			}
			ctx.ui.notify(`Removed ${removed} session(s), reclaimed ${formatSize(bytes)}.`, "info");
		}
	}
}
