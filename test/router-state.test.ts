import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRouterInstallationId, RouterRequestState } from "../src/extensions/router/state.ts";

const model: Model<"openai-responses"> = {
	api: "openai-responses",
	provider: "router-test",
	id: "synthetic",
	name: "Synthetic",
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 10000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const response = (token: string, status = 200) => ({ status, headers: { "X-Codex-Turn-State": token } });

describe("RouterRequestState", () => {
	it("keeps installation, session, thread, window and turn metadata consistent across tool continuations", () => {
		const state = new RouterRequestState("installation-test");
		const first = state.request(model, context, "session-test");
		const metadata = JSON.parse(String(first.headers["x-codex-turn-metadata"]));
		expect(metadata).toMatchObject({
			installation_id: "installation-test",
			session_id: "session-test",
			thread_id: "session-test",
			request_kind: "turn",
			turn_started_at_unix_ms: expect.any(Number),
		});
		expect(first.clientMetadata).toMatchObject({
			session_id: "session-test",
			thread_id: "session-test",
			turn_id: metadata.turn_id,
			"x-codex-window-id": metadata.window_id,
			"x-codex-installation-id": "installation-test",
			"x-codex-turn-metadata": first.headers["x-codex-turn-metadata"],
		});
		expect(first.headers).toMatchObject({
			"session-id": "session-test",
			"thread-id": "session-test",
			"x-client-request-id": "session-test",
			"x-codex-window-id": metadata.window_id,
		});
		expect(first.promptCacheKey).toBe("session-test");
		first.acceptResponse(response("opaque-first"));
		const continuation: Context = {
			messages: [
				...context.messages,
				{
					role: "toolResult",
					toolCallId: "call_test",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const next = state.request(model, continuation, "session-test");
		expect(next.clientMetadata).toEqual(first.clientMetadata);
		expect(next.headers["x-codex-turn-state"]).toBe("opaque-first");
		expect(first.headers).not.toHaveProperty("x-codex-turn-state");
	});

	it("isolates user turns, providers, models, base URLs, sessions and extension hosts", () => {
		const state = new RouterRequestState("installation-test");
		const first = state.request(model, context, "session-test");
		first.acceptResponse(response("private-token"));
		const alternatives = [
			state.request(
				model,
				{ messages: [...context.messages, { role: "user", content: "next", timestamp: 3 }] },
				"session-test",
			),
			state.request({ ...model, provider: "other" }, context, "session-test"),
			state.request({ ...model, id: "other" }, context, "session-test"),
			state.request({ ...model, baseUrl: "http://127.0.0.1:2/v1" }, context, "session-test"),
			state.request(model, context, "other-session"),
			new RouterRequestState("installation-test").request(model, context, "session-test"),
		];
		for (const next of alternatives) {
			expect(next.headers).not.toHaveProperty("x-codex-turn-state");
			expect(next.clientMetadata.turn_id).not.toBe(first.clientMetadata.turn_id);
		}
	});

	it("reset invalidates old scopes even when their outstanding responses arrive later", () => {
		const state = new RouterRequestState();
		const old = state.request(model, context, "session");
		state.reset();
		const fresh = state.request(model, context, "session");
		old.acceptResponse(response("late-token"));
		expect(state.request(model, context, "session").headers).not.toHaveProperty("x-codex-turn-state");
		fresh.acceptResponse(response("fresh-token"));
		expect(state.request(model, context, "session").headers["x-codex-turn-state"]).toBe("fresh-token");
		expect(fresh.clientMetadata.turn_id).not.toBe(old.clientMetadata.turn_id);
	});

	it.each(["", "x".repeat(8193), "bad\ntoken", "nonascii-\u00e9"])(
		"rejects invalid or oversized tokens (%#) without preventing a later valid token",
		(token) => {
			const state = new RouterRequestState();
			const first = state.request(model, context, "session");
			first.acceptResponse(response(token));
			first.acceptResponse(response("error-token", 500));
			expect(state.request(model, context, "session").headers).not.toHaveProperty("x-codex-turn-state");
			first.acceptResponse(response("x".repeat(8192)));
			first.acceptResponse(response("second"));
			expect(state.request(model, context, "session").headers["x-codex-turn-state"]).toBe("x".repeat(8192));
		},
	);

	it("bounds retained scopes and does not resurrect evicted scopes from late responses", () => {
		const state = new RouterRequestState();
		const old = state.request(model, context, "first");
		for (let index = 0; index < 128; index++) state.request(model, context, `session-${index}`);
		old.acceptResponse(response("evicted"));
		const fresh = state.request(model, context, "first");
		expect(fresh.clientMetadata.turn_id).not.toBe(old.clientMetadata.turn_id);
		expect(fresh.headers).not.toHaveProperty("x-codex-turn-state");
	});
});

describe("router installation persistence", () => {
	let directory: string | undefined;
	afterEach(async () => {
		vi.unstubAllEnvs();
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});
	it("creates one non-secret installation identity and reuses it across concurrent loads", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-router-state-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		const ids = await Promise.all(Array.from({ length: 8 }, () => loadRouterInstallationId()));
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
		expect(JSON.parse(await readFile(join(directory, "router-client.json"), "utf8"))).toEqual({
			version: 1,
			installationId: ids[0],
		});
		expect(await loadRouterInstallationId()).toBe(ids[0]);
	});
	it("does not silently overwrite an invalid existing identity", async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-router-state-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		const path = join(directory, "router-client.json");
		await writeFile(path, '{"installationId":"invalid"}');
		await expect(loadRouterInstallationId()).rejects.toThrow("invalid installation identity");
		expect(await readFile(path, "utf8")).toBe('{"installationId":"invalid"}');
	});
});
