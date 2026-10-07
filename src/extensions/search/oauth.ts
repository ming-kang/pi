import { createHash, randomBytes } from "node:crypto";

const WEB_BASE = "https://app.devin.ai";
const API_BASE = "https://api.devin.ai";
const MAX_CODE_CHARS = 8192;
const MAX_TOKEN_CHARS = 16_384;

export class OAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthError";
	}
}

export interface OAuthOptions {
	webBase?: string;
	apiBase?: string;
	fetcher?: typeof fetch;
}

export interface OAuthAttempt {
	url: string;
	/** Never leaves this process. */
	verifier: string;
	state: string;
}

export function createAuthorizeUrl(options: OAuthOptions = {}): OAuthAttempt {
	const verifier = randomBytes(64).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(32).toString("base64url");
	const url = new URL("/auth/cli/continue", options.webBase ?? WEB_BASE);
	url.search = new URLSearchParams({
		state,
		prompt: "select_account",
		code_challenge: challenge,
		code_challenge_method: "S256",
	}).toString();
	return { url: url.toString(), verifier, state };
}

export function validateCode(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_CODE_CHARS) {
		throw new OAuthError("Invalid Devin authorization code.");
	}
	const code = value.trim();
	if (!code || /[\s\x00-\x1f\x7f]/.test(code)) {
		throw new OAuthError("Invalid Devin authorization code.");
	}
	return code;
}

export async function exchangeCode(attempt: OAuthAttempt, code: string, options: OAuthOptions = {}): Promise<string> {
	let response: Response;
	try {
		response = await (options.fetcher ?? fetch)(`${options.apiBase ?? API_BASE}/auth/cli/token`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ code, code_verifier: attempt.verifier }),
			redirect: "error",
			signal: AbortSignal.timeout(120_000),
		});
	} catch {
		throw new OAuthError("Could not reach Devin's token endpoint. Check your network and retry /search.");
	}
	const text = await response.text();
	if (!response.ok) {
		throw new OAuthError(
			`Devin rejected the authorization code (HTTP ${response.status}). The code is one-time and short-lived — start /search again.`,
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new OAuthError("Devin returned a malformed token response.");
	}
	const token = (data as { token?: unknown })?.token;
	if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS) {
		throw new OAuthError("Devin returned no usable session token.");
	}
	return token;
}

export function tokenExpiresAt(token: string): number | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")) as {
			exp?: unknown;
		};
		return typeof payload?.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
			? payload.exp * 1000
			: undefined;
	} catch {
		return undefined;
	}
}
