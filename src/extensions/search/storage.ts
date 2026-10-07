import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";

export type KeySource = "manual" | "oauth";

export interface PersistedKey {
	apiKey: string;
	source: KeySource;
	obtainedAt?: string;
}

export function keyFilePath(): string {
	return join(getAgentDir(), "search", "config.json");
}

export function loadPersistedKey(): PersistedKey | undefined {
	try {
		const data = JSON.parse(readFileSync(keyFilePath(), "utf-8")) as {
			apiKey?: unknown;
			source?: unknown;
			obtainedAt?: unknown;
		};
		if (typeof data.apiKey !== "string" || !data.apiKey.trim()) return undefined;
		return {
			apiKey: data.apiKey.trim(),
			source: data.source === "oauth" ? "oauth" : "manual",
			...(typeof data.obtainedAt === "string" ? { obtainedAt: data.obtainedAt } : {}),
		};
	} catch {
		return undefined; // missing or unreadable — treat as no key
	}
}

export function savePersistedKey(key: string, source: KeySource): void {
	const path = keyFilePath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const payload: PersistedKey = { apiKey: key, source, obtainedAt: new Date().toISOString() };
	writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	try {
		chmodSync(path, 0o600); // no-op on platforms without POSIX perms
	} catch {}
}

export function deletePersistedKey(): void {
	try {
		rmSync(keyFilePath(), { force: true });
	} catch {}
}
