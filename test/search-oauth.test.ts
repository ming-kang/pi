import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createAuthorizeUrl,
	exchangeCode,
	OAuthError,
	tokenExpiresAt,
	validateCode,
} from "../src/extensions/search/oauth.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("search oauth", () => {
	it("builds an authorize URL whose challenge is S256(verifier)", () => {
		const attempt = createAuthorizeUrl();
		const url = new URL(attempt.url);
		expect(url.origin + url.pathname).toBe("https://app.devin.ai/auth/cli/continue");
		const params = url.searchParams;
		expect(params.get("code_challenge_method")).toBe("S256");
		expect(params.get("prompt")).toBe("select_account");
		expect(attempt.state).toBe(params.get("state"));
		expect(attempt.state.length).toBeGreaterThanOrEqual(32);
		const expected = createHash("sha256").update(attempt.verifier).digest("base64url");
		expect(params.get("code_challenge")).toBe(expected);
		expect(params.has("redirect_uri")).toBe(false);
	});

	it("generates a fresh verifier per attempt", () => {
		expect(createAuthorizeUrl().verifier).not.toBe(createAuthorizeUrl().verifier);
	});

	it("validateCode trims and accepts a plausible code", () => {
		expect(validateCode("  GofTneOCguiZrAEqLcKZ4N1xYDdkoXz3HvdlM7YcHkE  ")).toBe(
			"GofTneOCguiZrAEqLcKZ4N1xYDdkoXz3HvdlM7YcHkE",
		);
	});

	it("validateCode rejects empty, whitespace, control chars, non-strings, and oversize", () => {
		expect(() => validateCode("")).toThrow(OAuthError);
		expect(() => validateCode("   ")).toThrow(OAuthError);
		expect(() => validateCode("abc\ndef")).toThrow(OAuthError);
		expect(() => validateCode("abc\x00def")).toThrow(OAuthError);
		expect(() => validateCode(undefined)).toThrow(OAuthError);
		expect(() => validateCode("x".repeat(8193))).toThrow(OAuthError);
	});

	it("validateCode errors never echo the code", () => {
		try {
			validateCode("bad\u0001code");
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).not.toContain("bad");
		}
	});

	it("exchanges code + verifier for a token", async () => {
		const attempt = createAuthorizeUrl();
		let seen: { url: string; body: unknown } | undefined;
		const fetcher = (async (url: string, init: RequestInit) => {
			seen = { url: String(url), body: JSON.parse(String(init.body)) };
			return jsonResponse({ token: "jwt-token-value" });
		}) as unknown as typeof fetch;
		const token = await exchangeCode(attempt, "one-time-code", { fetcher });
		expect(token).toBe("jwt-token-value");
		expect(seen?.url).toBe("https://api.devin.ai/auth/cli/token");
		expect(seen?.body).toEqual({ code: "one-time-code", code_verifier: attempt.verifier });
	});

	it("rejects a non-ok exchange with the status but no body", async () => {
		const fetcher = (async () => jsonResponse({ internal: "secret-details" }, 400)) as unknown as typeof fetch;
		await expect(exchangeCode(createAuthorizeUrl(), "code", { fetcher })).rejects.toThrow(/HTTP 400/);
		try {
			await exchangeCode(createAuthorizeUrl(), "code", { fetcher });
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).not.toContain("secret-details");
		}
	});

	it("rejects malformed JSON and missing token", async () => {
		const badJson = (async () => new Response("<html>nope", { status: 200 })) as unknown as typeof fetch;
		await expect(exchangeCode(createAuthorizeUrl(), "code", { fetcher: badJson })).rejects.toThrow(OAuthError);
		const noToken = (async () => jsonResponse({ session: null })) as unknown as typeof fetch;
		await expect(exchangeCode(createAuthorizeUrl(), "code", { fetcher: noToken })).rejects.toThrow(OAuthError);
	});

	it("reports network failures without leaking the fetcher error", async () => {
		const boom = (async () => {
			throw new Error("ECONNREFUSED 10.1.2.3:443");
		}) as unknown as typeof fetch;
		await expect(exchangeCode(createAuthorizeUrl(), "code", { fetcher: boom })).rejects.toThrow(/token endpoint/);
	});

	it("tokenExpiresAt reads JWT exp and tolerates opaque tokens", () => {
		const payload = Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url");
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
		expect(tokenExpiresAt(jwt)).toBe(4102444800 * 1000);
		expect(tokenExpiresAt("opaque-session-token")).toBeUndefined();
		expect(tokenExpiresAt("a.b.c")).toBeUndefined();
	});
});
