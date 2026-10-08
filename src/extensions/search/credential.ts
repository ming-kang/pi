/**
 * The one Devin credential both tools share, and the browser sign-in that obtains it.
 *
 * Devin's CLI sign-in returns a bare session JWT; the Windsurf backends accept it only as
 * `devin-session-token$<JWT>`. `toApiKey` is the single place that rule lives.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { FileAuthStorageBackend } from "../../core/auth-storage.ts";

export const ENV_KEY = "SEARCH_KEY";

const SESSION_PREFIX = "devin-session-token$";
const AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
const TOKEN_URL = "https://api.devin.ai/auth/cli/token";
const MAX_INPUT_CHARS = 16_384;

/** `{ "devin": { "token": "<as Devin issued it>" } }`, beside auth.json and mcp-auth.json. */
export function credentialPath(): string {
	return join(getAgentDir(), "search-auth.json");
}

const PROVIDER = "devin";

/** A Devin session JWT gains its prefix; anything else (an already prefixed key) passes through. */
export function toApiKey(token: string): string {
	const value = token.trim();
	return /^eyJ[\w-]*\.[\w-]*\.[\w-]*$/.test(value) ? `${SESSION_PREFIX}${value}` : value;
}

type StoredTokens = Record<string, { token?: unknown } | undefined>;

function parseStored(current: string | undefined): StoredTokens {
	try {
		const data = JSON.parse(current ?? "{}") as unknown;
		return data && typeof data === "object" && !Array.isArray(data) ? (data as StoredTokens) : {};
	} catch {
		return {};
	}
}

/** Read-modify-write under the file lock that auth.json and mcp-auth.json also use. */
function updateStored(change: (stored: StoredTokens) => void): void {
	new FileAuthStorageBackend(credentialPath()).withLock((current) => {
		const stored = parseStored(current);
		change(stored);
		return { result: undefined, next: `${JSON.stringify(stored, null, 2)}\n` };
	});
}

function readSaved(): string | undefined {
	// Checked first so a session that never signs in does not create the file.
	if (!existsSync(credentialPath())) return undefined;
	const token = new FileAuthStorageBackend(credentialPath()).withLock((current) => ({
		result: parseStored(current)[PROVIDER]?.token,
	}));
	return typeof token === "string" && token.trim() ? token.trim() : undefined;
}

export type CredentialSource = "saved" | "env";

/** Read on every call, so a sign-in elsewhere or an edited file applies without a restart. */
export function getCredential(): { apiKey: string; source: CredentialSource } | undefined {
	const saved = readSaved();
	if (saved) return { apiKey: toApiKey(saved), source: "saved" };
	const env = process.env[ENV_KEY]?.trim();
	return env ? { apiKey: toApiKey(env), source: "env" } : undefined;
}

/** Saves the token exactly as Devin issued it; the request prefix is added at use. */
export function saveCredential(token: string): void {
	updateStored((stored) => {
		stored[PROVIDER] = { token: token.trim() };
	});
}

export function deleteCredential(): void {
	if (!existsSync(credentialPath())) return;
	updateStored((stored) => {
		delete stored[PROVIDER];
	});
}

/** Whether pasted text is a token rather than a one-time authorization code. */
export function looksLikeToken(value: string): boolean {
	return value.startsWith(SESSION_PREFIX) || toApiKey(value) !== value;
}

export interface SignInAttempt {
	url: string;
	/** Never leaves this process. */
	verifier: string;
}

/** PKCE S256 without a redirect: Devin shows the code in the browser and the user pastes it back. */
export function createSignIn(): SignInAttempt {
	const verifier = randomBytes(64).toString("base64url");
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		state: randomBytes(32).toString("base64url"),
		prompt: "select_account",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
	}).toString();
	return { url: url.toString(), verifier };
}

export async function exchangeCode(
	attempt: SignInAttempt,
	input: string,
	fetcher: typeof fetch = fetch,
): Promise<string> {
	const code = input.trim();
	if (!code || code.length > MAX_INPUT_CHARS || /\s|[\x00-\x1f\x7f]/.test(code)) {
		throw new Error("That does not look like a Devin authorization code.");
	}
	let response: Response;
	try {
		response = await fetcher(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ code, code_verifier: attempt.verifier }),
			redirect: "error",
			signal: AbortSignal.timeout(60_000),
		});
	} catch {
		throw new Error("Could not reach Devin. Check your network and run /search again.");
	}
	if (!response.ok) {
		throw new Error(`Devin rejected the code (HTTP ${response.status}). Codes are one-time; run /search again.`);
	}
	const token = ((await response.json().catch(() => undefined)) as { token?: unknown } | undefined)?.token;
	if (typeof token !== "string" || !token || token.length > MAX_INPUT_CHARS) {
		throw new Error("Devin returned no usable session token.");
	}
	return token;
}
