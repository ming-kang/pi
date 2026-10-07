import { clearJwtCache } from "./client.ts";
import { ENV_KEY } from "./constants.ts";
import { isAcceptableApiKey, looksTruncated, TRUNCATED_KEY_HINT } from "./key-format.ts";
import { deletePersistedKey, type KeySource, loadPersistedKey, savePersistedKey } from "./storage.ts";

export type EffectiveKeySource = KeySource | "env";

export interface KeyInfo {
	key: string;
	source: EffectiveKeySource;
}

function warnIfTruncated(key: string | undefined, source: string): void {
	if (key && looksTruncated(key)) {
		console.warn(`[Search] ${source} ${TRUNCATED_KEY_HINT}`);
	}
}

const persisted = loadPersistedKey();
const envKey = process.env[ENV_KEY]?.trim();
warnIfTruncated(persisted?.apiKey, "saved key");
if (!persisted) warnIfTruncated(envKey, ENV_KEY);

let keyInfo: KeyInfo | undefined = persisted
	? { key: persisted.apiKey, source: persisted.source }
	: isAcceptableApiKey(envKey)
		? { key: envKey.trim(), source: "env" }
		: undefined;

export function getApiKey(): string | undefined {
	return keyInfo?.key;
}

export function getKeyInfo(): KeyInfo | undefined {
	return keyInfo;
}

export function setApiKey(key: string, source: KeySource): void {
	const next = key.trim();
	if (!isAcceptableApiKey(next)) return;
	warnIfTruncated(next, "new key");
	if (keyInfo && keyInfo.key !== next) clearJwtCache(keyInfo.key);
	keyInfo = { key: next, source };
	savePersistedKey(next, source);
}

export function clearApiKey(): void {
	if (keyInfo) clearJwtCache(keyInfo.key);
	keyInfo = undefined;
	deletePersistedKey();
}

export function maskKey(key: string): string {
	const head = key.slice(0, 24);
	const tail = key.length > 32 ? key.slice(-4) : "";
	return tail ? `${head}…${tail}` : head;
}
