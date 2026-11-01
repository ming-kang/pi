import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const tempDirs: string[] = [];
const clients: RpcClient[] = [];

/** A child speaking just enough RPC: `get_state` answers `isQuiescent`; `prompt` replays a scripted event sequence. */
function createClient(options: { quiescent: boolean; events: unknown[] }): RpcClient {
	const dir = mkdtempSync(join(tmpdir(), "pi-rpc-client-quiescence-"));
	tempDirs.push(dir);
	const path = join(dir, "child.mjs");
	writeFileSync(
		path,
		`
import { createInterface } from "node:readline";
const events = ${JSON.stringify(options.events)};
createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	const data = command.type === "get_state" ? { isQuiescent: ${options.quiescent} } : command.type === "prompt" ? { disposition: "started" } : undefined;
	process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }) + "\\n");
	if (command.type !== "prompt") return;
	events.forEach((event, index) => setTimeout(() => process.stdout.write(JSON.stringify(event) + "\\n"), 20 * (index + 1)));
});
`,
	);
	const client = new RpcClient({ cliPath: path });
	clients.push(client);
	return client;
}

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => {})));
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const settled = { type: "agent_settled", aborted: false };
const quiescent = { type: "session_quiescent" };

describe("RpcClient quiescence", () => {
	test("waitForQuiescence resolves at once when the session is already quiescent", async () => {
		const client = createClient({ quiescent: true, events: [] });
		await client.start();
		await client.waitForQuiescence(5000);
	});

	test("waitForQuiescence outlasts agent_settled until session_quiescent", async () => {
		const client = createClient({ quiescent: false, events: [settled, settled, quiescent] });
		await client.start();
		const seen: string[] = [];
		client.onEvent((event) => seen.push(event.type));
		const waiting = client.waitForQuiescence(5000).then(() => seen.length);
		await client.prompt("go");
		// Resolved only after both settlements, unlike waitForIdle().
		expect(await waiting).toBe(3);
		expect(seen).toEqual(["agent_settled", "agent_settled", "session_quiescent"]);
	});

	test("collectEventsUntilQuiescent returns the background completion turn's events", async () => {
		const client = createClient({ quiescent: false, events: [settled, { type: "agent_start" }, settled, quiescent] });
		await client.start();
		const events = client.collectEventsUntilQuiescent(5000);
		await client.prompt("go");
		expect((await events).map((event) => event.type)).toEqual([
			"agent_settled",
			"agent_start",
			"agent_settled",
			"session_quiescent",
		]);
	});

	test("waitForQuiescence times out with the stderr context", async () => {
		const client = createClient({ quiescent: false, events: [] });
		await client.start();
		await expect(client.waitForQuiescence(50)).rejects.toThrow(/Timeout waiting for session to become quiescent/);
	});
});
