import type { FetchFunction } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildCodexHeaders,
	CODEX_ORIGINATOR,
	CODEX_VERSION,
	createCodexFetch,
	formatCodexUserAgent,
	getCodexTerminal,
	getCodexUserAgent,
} from "../src/extensions/router/identity.ts";

const endpoint = "https://relay.example/v1/responses";

function captureFetch() {
	const requests: Request[] = [];
	const response = new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	const fetch = vi.fn<FetchFunction>(async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		request.signal.throwIfAborted();
		return response;
	});
	return { fetch, requests, response };
}

describe("Codex 0.153.4 identity", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("uses os_info display names and the official terminal token format", () => {
		expect(CODEX_VERSION).toBe("0.153.4");
		expect(CODEX_ORIGINATOR).toBe("codex_cli_rs");
		expect(formatCodexUserAgent("Windows", "10.0.26100", "x86_64", { WT_SESSION: "session" })).toBe(
			"codex_cli_rs/0.153.4 (Windows 10.0.26100; x86_64) WindowsTerminal",
		);
		expect(
			formatCodexUserAgent("Mac OS", "15.4", "aarch64", { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5" }),
		).toBe("codex_cli_rs/0.153.4 (Mac OS 15.4; aarch64) iTerm.app/3.5");
		expect(getCodexUserAgent()).toMatch(/^codex_cli_rs\/0\.153\.4 \(.+; .+\) \S+$/);
	});

	it.each([
		[{ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.99", WT_SESSION: "x" }, "vscode/1.99"],
		[{ TERM_PROGRAM: " ", WT_SESSION: "" }, "WindowsTerminal"],
		[{ WEZTERM_VERSION: "2025", ITERM_SESSION_ID: "x" }, "WezTerm/2025"],
		[{ ITERM_PROFILE_NAME: "" }, "iTerm.app"],
		[{ TERM_SESSION_ID: "x" }, "Apple_Terminal"],
		[{ TERM: "xterm-kitty" }, "kitty"],
		[{ TERM: "alacritty" }, "Alacritty"],
		[{ KONSOLE_VERSION: "2401" }, "Konsole/2401"],
		[{ GNOME_TERMINAL_SCREEN: "x", VTE_VERSION: "700" }, "gnome-terminal"],
		[{ VTE_VERSION: "700" }, "VTE/700"],
		[{ TERM: "xterm-256color" }, "xterm-256color"],
		[{ TERM: "dumb" }, "dumb"],
		[{}, "unknown"],
		[{ TERM_PROGRAM: "A B\r\n😀", TERM_PROGRAM_VERSION: "1+2" }, "A_B___/1_2"],
		[{ TERM_PROGRAM: "tmux", TMUX: "x", TERM_PROGRAM_VERSION: "3.5" }, "tmux/3.5"],
	])("detects environment %j", (env, expected) => {
		expect(getCodexTerminal(env)).toBe(expected);
	});

	it("merges configured values and nulls case-insensitively without mutating input", () => {
		const configured = {
			"User-Agent": null,
			ORIGINATOR: "tenant",
			ACCEPT: null,
			"Content-Type": "custom/json",
			"X-Stainless-Lang": "explicit",
			"X-Api-Key": "secret",
			session_ID: "must-not-leak",
		};
		const headers = buildCodexHeaders(configured);
		expect(headers).toMatchObject({
			"user-agent": null,
			originator: "tenant",
			accept: null,
			"content-type": "custom/json",
			"x-stainless-lang": "explicit",
			"x-api-key": "secret",
			session_id: null,
		});
		expect(headers["x-stainless-runtime"]).toBeNull();
		expect(headers["x-session-affinity"]).toBeNull();
		expect(Object.keys(headers).every((key) => key === key.toLowerCase())).toBe(true);
		expect(configured.session_ID).toBe("must-not-leak");
		expect(buildCodexHeaders()).toMatchObject({
			accept: "text/event-stream",
			"content-type": "application/json",
			originator: CODEX_ORIGINATOR,
		});
	});

	it("cleans post-SDK headers, keeps tenant/auth/lifecycle headers and custom fetch response", async () => {
		const { fetch, requests, response } = captureFetch();
		const init = {
			method: "POST",
			body: '{"stream":true}',
			headers: {
				Accept: "application/json",
				"X-Stainless-Future-Header": "sdk",
				"x-Stainless-Lang": "js",
				"X-Pi-Attribution": "pi",
				"X-Session-Affinity": "pi",
				SESSION_ID: "pi",
				Authorization: "Bearer secret",
				"api-key": "key",
				"OpenAI-Organization": "org",
				"OpenAI-Project": "project",
				"X-Tenant": "tenant",
				"session-id": "session",
				"thread-id": "thread",
				"User-Agent": "configured",
			},
		};
		expect(await createCodexFetch(fetch)(new URL(endpoint), init)).toBe(response);
		expect(fetch).toHaveBeenCalledOnce();
		const sentHeaders: Record<string, string> = {};
		requests[0].headers.forEach((value, name) => {
			sentHeaders[name] = value;
		});
		expect(sentHeaders).toEqual({
			accept: "text/event-stream",
			authorization: "Bearer secret",
			"api-key": "key",
			"openai-organization": "org",
			"openai-project": "project",
			"x-tenant": "tenant",
			"session-id": "session",
			"thread-id": "thread",
			"user-agent": "configured",
			"content-type": "text/plain;charset=UTF-8",
		});
		expect(await requests[0].text()).toBe(init.body);
		expect(init.headers.Accept).toBe("application/json");
	});

	it("preserves Request bodies/signals and native init header replacement semantics", async () => {
		const { fetch, requests } = captureFetch();
		const controller = new AbortController();
		const request = new Request(endpoint, {
			method: "POST",
			body: "original",
			signal: controller.signal,
			headers: { Authorization: "Bearer old", "x-stainless-os": "sdk", Accept: "application/json" },
		});
		await createCodexFetch(fetch)(request);
		expect(await requests[0].text()).toBe("original");
		expect(requests[0].headers.get("authorization")).toBe("Bearer old");
		expect(request.headers.get("x-stainless-os")).toBe("sdk");
		controller.abort();
		expect(requests[0].signal.aborted).toBe(true);
		const replacement = new Request(endpoint, { method: "POST", body: "old", headers: { "x-old": "removed" } });
		await createCodexFetch(fetch)(replacement, { body: "new", headers: { "X-Api-Key": "new" } });
		expect(requests[1].headers.has("x-old")).toBe(false);
		expect(requests[1].headers.get("x-api-key")).toBe("new");
		expect(await requests[1].text()).toBe("new");
	});

	it("forwards Node streaming-body duplex and additional init options unchanged", async () => {
		const { fetch, requests } = captureFetch();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("stream body"));
				controller.close();
			},
		});
		const init: RequestInit & { duplex: "half"; dispatcher: object } = {
			method: "POST",
			body,
			duplex: "half",
			dispatcher: {},
			redirect: "manual",
			headers: { Accept: "application/json" },
		};
		await createCodexFetch(fetch)(endpoint, init);
		expect(fetch.mock.calls[0][1]).toMatchObject({ duplex: "half", redirect: "manual" });
		expect(fetch.mock.calls[0][1]).toHaveProperty("dispatcher", init.dispatcher);
		expect(fetch.mock.calls[0][1]?.body).toBe(body);
		expect(await requests[0].text()).toBe("stream body");
	});

	it("forwards aborted signals for both URL+init and Request calls", async () => {
		const { fetch } = captureFetch();
		const controller = new AbortController();
		const reason = new Error("cancelled");
		controller.abort(reason);
		await expect(createCodexFetch(fetch)(endpoint, { signal: controller.signal })).rejects.toBe(reason);
		await expect(createCodexFetch(fetch)(new Request(endpoint, { signal: controller.signal }))).rejects.toBe(reason);
	});

	it("retains models discovery JSON Accept and does not resurrect SDK-removed nullable headers", async () => {
		const { fetch, requests } = captureFetch();
		await createCodexFetch(fetch)("https://relay.example/v1/models", { headers: { Accept: "application/json" } });
		expect(requests[0].headers.get("accept")).toBe("application/json");
		const configured = buildCodexHeaders({
			Accept: null,
			"User-Agent": null,
			originator: null,
			"Content-Type": null,
		});
		const assembled = new Headers();
		for (const [key, value] of Object.entries(configured)) if (value !== null) assembled.set(key, value);
		await createCodexFetch(fetch)(endpoint, { method: "POST", headers: assembled });
		for (const key of ["accept", "user-agent", "originator", "content-type"])
			expect(requests[1].headers.has(key)).toBe(false);
	});

	it("uses a bound global fetch by default, without modifying it", async () => {
		let receiver: unknown;
		const globalFetch: FetchFunction = async function (this: unknown) {
			receiver = this;
			return new Response(null);
		};
		vi.stubGlobal("fetch", globalFetch);
		await createCodexFetch()(endpoint);
		expect(receiver).toBe(globalThis);
		expect(globalThis.fetch).toBe(globalFetch);
	});
});
