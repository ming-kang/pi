import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSignIn,
	deleteCredential,
	exchangeCode,
	getCredential,
	saveCredential,
} from "../src/extensions/search/credential.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uX2lkIjoieCJ9.c2ln";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "search-credential-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.SEARCH_KEY;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.SEARCH_KEY;
});

describe("search credential", () => {
	it("turns the bare JWT that Devin's sign-in returns into the session-token API key", () => {
		saveCredential(JWT);
		expect(getCredential()).toEqual({ apiKey: `devin-session-token$${JWT}`, source: "saved" });
	});

	it("passes an already prefixed token through unchanged", () => {
		process.env.SEARCH_KEY = `devin-session-token$${JWT}`;
		expect(getCredential()).toEqual({ apiKey: `devin-session-token$${JWT}`, source: "env" });
	});

	it("prefers the saved token over SEARCH_KEY and sees a sign-out immediately", () => {
		process.env.SEARCH_KEY = "env-key";
		saveCredential(JWT);
		expect(getCredential()?.source).toBe("saved");
		deleteCredential();
		expect(getCredential()).toEqual({ apiKey: "env-key", source: "env" });
	});

	it("binds the authorization code to the verifier whose S256 hash was in the sign-in URL", async () => {
		const attempt = createSignIn();
		const challenge = new URL(attempt.url).searchParams.get("code_challenge");
		const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as { code: string; code_verifier: string };
			expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
			expect(body.code).toBe("abc123");
			return new Response(JSON.stringify({ token: JWT }));
		});
		await expect(exchangeCode(attempt, "  abc123 ", fetcher as unknown as typeof fetch)).resolves.toBe(JWT);
	});

	it("reports a rejected code instead of saving anything", async () => {
		const fetcher = vi.fn(async () => new Response("{}", { status: 400 }));
		await expect(exchangeCode(createSignIn(), "abc", fetcher as unknown as typeof fetch)).rejects.toThrow(
			/rejected the code/,
		);
	});
});
