/**
 * config.ts — load/save the rewind extension's settings at
 * <rewindDir>/config.json. Tolerant parse, atomic write, sensible defaults
 * so a missing/corrupt file never breaks the session.
 *
 * Settings are user-editable via the /rewind menu (menu.ts).
 */
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { rewindConfigPath } from "./paths.ts";

export interface RewindConfig {
	/** Master switch. When false, no backups are taken and rewind is inert. */
	enabled: boolean;
	/** Backups for sessions whose dir is older than this are GC'd. 0 = keep forever. */
	retentionDays: number;
	/** Cap on retained snapshots per session. */
	maxSnapshots: number;
}

export const DEFAULT_CONFIG: RewindConfig = {
	enabled: true,
	retentionDays: 30,
	maxSnapshots: 100,
};

export const MAX_RETENTION_DAYS = 3650;
export const MAX_SNAPSHOTS = 1000;

/** In-process cache so lifecycle hooks do not re-read config.json every turn. */
let cached: RewindConfig | null = null;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function normalize(raw: unknown): RewindConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const r = raw as Partial<RewindConfig>;
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_CONFIG.enabled,
		retentionDays: clampInt(r.retentionDays, 0, MAX_RETENTION_DAYS, DEFAULT_CONFIG.retentionDays),
		maxSnapshots: clampInt(r.maxSnapshots, 1, MAX_SNAPSHOTS, DEFAULT_CONFIG.maxSnapshots),
	};
}

function readConfigFromDisk(): RewindConfig {
	const configPath = rewindConfigPath();
	if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
	try {
		return normalize(JSON.parse(readFileSync(configPath, "utf8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Cached config (reads disk once, then serves memory until reload/save). */
export function loadRewindConfig(): RewindConfig {
	if (!cached) cached = readConfigFromDisk();
	return cached;
}

/** Force a disk re-read (call on session_start so external edits take effect). */
export function reloadRewindConfig(): RewindConfig {
	cached = readConfigFromDisk();
	return cached;
}

/** Parse the menu's custom retention field without accepting numeric prefixes or fractions. */
export function parseRetentionDays(value: string): number | undefined {
	const trimmed = value.trim();
	if (!/^(?:0|[1-9][0-9]*)$/.test(trimmed)) return undefined;
	const days = Number(trimmed);
	return Number.isSafeInteger(days) && days <= MAX_RETENTION_DAYS ? days : undefined;
}

let configWriteSequence = 0;

/** Persist and update the in-memory cache so the next turn sees the change. */
export function saveRewindConfig(config: RewindConfig): boolean {
	const next = normalize(config);
	const configPath = rewindConfigPath();
	const temporary = `${configPath}.${process.pid}.${++configWriteSequence}.tmp`;
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		const fd = openSync(temporary, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, configPath);
		cached = next;
		return true;
	} catch {
		try {
			unlinkSync(temporary);
		} catch {
			// best-effort cleanup
		}
		return false;
	}
}
