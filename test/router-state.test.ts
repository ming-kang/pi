import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

	it.each([
		"x".repeat(64),
		"x".repeat(65),
		"x".repeat(256),
		"x".repeat(257),
		"\u4f1a\u8bdd",
		"bad\ntoken",
		"trailing\n",
		"trailing\r",
		"bad\0token",
		"bad\x7ftoken",
		" leading space",
		"trailing space ",
		"   ",
		"! ~",
	])("normalizes session identities consistently and retains tool-loop state (%#)", (session) => {
		const expected =
			session === "x".repeat(64) || session === "! ~" ? session : createHash("sha256").update(session).digest("hex");
		const state = new RouterRequestState();
		const first = state.request(model, context, session);
		expect(first.promptCacheKey).toBe(expected);
		expect(first.headers).toMatchObject({
			"session-id": expected,
			"thread-id": expected,
			"x-client-request-id": expected,
		});
		expect(first.clientMetadata).toMatchObject({ session_id: expected, thread_id: expected });
		expect(JSON.parse(String(first.headers["x-codex-turn-metadata"]))).toMatchObject({
			session_id: expected,
			thread_id: expected,
		});
		first.acceptResponse(response("retained"));
		const next = state.request(
			model,
			{
				messages: [
					...context.messages,
					{ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 2 },
				],
			},
			session,
		);
		expect(next.clientMetadata).toEqual(first.clientMetadata);
		expect(next.headers["x-codex-turn-state"]).toBe("retained");
		expect(new RouterRequestState().request(model, context, session).promptCacheKey).toBe(expected);
	});

	it("does not truncate long identities sharing a prefix, and generates UUIDs for missing identities", () => {
		const state = new RouterRequestState();
		const prefix = "x".repeat(256);
		expect(state.request(model, context, `${prefix}a`).promptCacheKey).not.toBe(
			state.request(model, context, `${prefix}b`).promptCacheKey,
		);
		const first = state.request(model, context);
		expect(first.promptCacheKey).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
		expect(state.request(model, context, "").promptCacheKey).not.toBe(first.promptCacheKey);
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

interface IdentityMessage {
	type: string;
	value?: string;
}

function identityProcess(directory: string, mode = "load") {
	const env: NodeJS.ProcessEnv = {
		PI_CODING_AGENT_DIR: directory,
		PI_OFFLINE: "1",
		HOME: directory,
		USERPROFILE: directory,
	};
	for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	const child = fork(fileURLToPath(new URL("./fixtures/router/identity-process.ts", import.meta.url)), [mode], {
		execArgv: ["--import", "tsx"],
		env,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const messages: IdentityMessage[] = [];
	let stderr = "";
	child.stderr?.on("data", (data) => {
		stderr += String(data);
	});
	child.on("message", (message) => messages.push(message as IdentityMessage));
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const wait = (type: string): Promise<IdentityMessage> => {
		const found = messages.find((message) => message.type === type);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				child.off("message", onMessage);
				child.off("exit", onExit);
			};
			const onMessage = (message: unknown) => {
				const event = message as IdentityMessage;
				if (event.type === type) {
					cleanup();
					resolve(event);
				}
			};
			const onExit = () => {
				cleanup();
				reject(new Error(`Identity child exited waiting for ${type}: ${JSON.stringify(messages)} ${stderr}`));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Identity child timed out waiting for ${type}: ${stderr}`));
			}, 15_000);
			child.on("message", onMessage);
			child.once("exit", onExit);
			if (child.exitCode !== null) onExit();
		});
	};
	return { child, messages, wait, exited };
}

describe("router installation persistence", () => {
	let directory: string | undefined;
	const children: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
	const spawn = (mode = "load") => {
		const worker = identityProcess(directory!, mode);
		children.push(worker);
		return worker;
	};
	const isolate = async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-router-state-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", directory);
		return join(directory, "router-client.json");
	};
	afterEach(async () => {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		await Promise.all(children.splice(0).map(({ exited }) => exited));
		vi.unstubAllEnvs();
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});
	it("publishes complete JSON atomically while independent processes wait on the lock", async () => {
		const path = await isolate();
		const writer = spawn("pause-write");
		await writer.wait("ready");
		writer.child.send("start");
		await writer.wait("partial");
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		const readers = Array.from({ length: 4 }, () => spawn());
		await Promise.all(readers.map((reader) => reader.wait("ready")));
		for (const reader of readers) reader.child.send("start");
		await Promise.all(readers.map((reader) => reader.wait("blocked")));
		for (const reader of readers) expect(reader.messages.map(({ type }) => type)).not.toContain("result");
		writer.child.send("resume");
		const results = await Promise.all([writer, ...readers].map((worker) => worker.wait("result")));
		expect(new Set(results.map(({ value }) => value)).size).toBe(1);
		expect(JSON.parse(await readFile(path, "utf8")).installationId).toBe(results[0].value);
		expect(await readdir(directory!)).toEqual(["router-client.json"]);
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("does not read an existing incomplete file while another process holds its lock", async () => {
		const path = await isolate();
		const holder = spawn("hold");
		await holder.wait("ready");
		holder.child.send("start");
		await holder.wait("held");
		await writeFile(path, "{");
		const reader = spawn();
		await reader.wait("ready");
		reader.child.send("start");
		await reader.wait("blocked");
		const text = '{ "version": 1, "installationId": "01234567-89ab-4cde-8fab-0123456789ab" }';
		await writeFile(path, text);
		const before = await stat(path);
		holder.child.send("release");
		expect((await reader.wait("result")).value).toBe(JSON.parse(text).installationId);
		expect(await readFile(path, "utf8")).toBe(text);
		expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
	});

	it.each(["fail-write", "fail-rename", "compromised"])(
		"cleans temporary files and releases the lock after %s",
		async (mode) => {
			await isolate();
			const writer = spawn(mode);
			await writer.wait("ready");
			writer.child.send("start");
			expect((await writer.wait("error")).value).toContain(
				mode === "compromised" ? "injected compromised lock" : `injected ${mode.slice("fail-".length)} failure`,
			);
			await writer.exited;
			expect(await readdir(directory!)).toEqual([]);
			expect(await loadRouterInstallationId()).toMatch(/^[0-9a-f-]{36}$/);
		},
	);

	it("bounds lock contention and recovers after release without reading or creating an identity", async () => {
		await isolate();
		const holder = spawn("hold");
		await holder.wait("ready");
		holder.child.send("start");
		await holder.wait("held");
		const reader = spawn();
		await reader.wait("ready");
		reader.child.send("start");
		await reader.wait("blocked");
		expect((await reader.wait("error")).value).toContain("Lock file is already being held");
		expect(await readdir(directory!)).toEqual(["router-client.json.lock"]);
		holder.child.send("release");
		await holder.wait("released");
		expect(await loadRouterInstallationId()).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("does not adopt a partial temporary file left by a terminated initializer", async () => {
		const path = await isolate();
		const writer = spawn("pause-write");
		await writer.wait("ready");
		writer.child.send("start");
		await writer.wait("partial");
		await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		const temporary = (await readdir(directory!)).find((name) => name.endsWith(".tmp"));
		expect(temporary).toBeDefined();
		writer.child.kill("SIGKILL");
		await writer.exited;
		// A hard kill cannot run cleanup. Age only this fixture's lock to avoid waiting 30s for recovery.
		try {
			const stale = new Date(Date.now() - 120_000);
			await utimes(`${path}.lock`, stale, stale);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const identity = await loadRouterInstallationId();
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, installationId: identity });
		expect(await readFile(join(directory!, temporary!), "utf8")).toBe("{");
		await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("recovers an abandoned stale lock", async () => {
		const path = await isolate();
		await mkdir(`${path}.lock`);
		const old = new Date(Date.now() - 120_000);
		await utimes(`${path}.lock`, old, old);
		expect(await loadRouterInstallationId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(await readdir(directory!)).toEqual(["router-client.json"]);
	});

	it.each(["{", '{"installationId":"------------------------------------"}', '{"installationId":"invalid"}'])(
		"preserves corrupt files across process loads (%#)",
		async (text) => {
			const path = await isolate();
			await writeFile(path, text);
			const reader = spawn();
			await reader.wait("ready");
			reader.child.send("start");
			await reader.wait("error");
			expect(await readFile(path, "utf8")).toBe(text);
			expect(await readdir(directory!)).toEqual(["router-client.json"]);
		},
	);

	it("keeps request-state construction side-effect free and supports a missing agent directory", async () => {
		await isolate();
		const nested = join(directory!, "not-created-yet");
		vi.stubEnv("PI_CODING_AGENT_DIR", nested);
		new RouterRequestState().request(model, context, "session");
		expect(await readdir(directory!)).toEqual([]);
		const id = await loadRouterInstallationId();
		expect(JSON.parse(await readFile(join(nested, "router-client.json"), "utf8")).installationId).toBe(id);
		expect(await readdir(nested)).toEqual(["router-client.json"]);
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
