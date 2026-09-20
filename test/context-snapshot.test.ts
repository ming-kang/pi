import type { Message, ModelsSimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { type TObject, Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BtwAgent } from "../src/extensions/btw/agent.ts";
import { btwDone, btwPending, btwResponse } from "./helpers/btw.ts";
import { createBtwTestSession } from "./helpers/btw-session.ts";

describe("SDK context snapshots", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()!();
	});

	it("reuses the prepared main prefix including context hooks, image policy, and signed messages", async () => {
		const requests: Array<{ messages: Message[]; systemPrompt: string; tools: Partial<Tool>[] }> = [];
		let contexts = 0;
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "never execute" }], details: {} }));
		const fixture = await createBtwTestSession({
			settings: { images: { blockImages: true }, transport: "sse", thinkingBudgets: { high: 1234 } },
			tools: [
				{
					name: "readonly",
					label: "Read",
					description: "Test tool",
					parameters: Type.Object({ z: Type.String(), a: Type.String() }),
					constrainedSampling: false,
					execute,
				},
			],
			extensions: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: [{ role: "user", content: `context-hook-${++contexts}`, timestamp: 0 }, ...event.messages],
					}));
					pi.on("before_agent_start", () => ({ systemPrompt: "Effective system prompt from hook" }));
				},
			],
			stream: (_model, context) => {
				requests.push(
					structuredClone({
						messages: [...context.messages],
						systemPrompt: getCurrentSystemPrompt(context.messages),
						tools: getCurrentTools(context.messages).map(
							({ name, description, parameters, constrainedSampling }) => ({
								name,
								description,
								parameters,
								constrainedSampling,
							}),
						),
					}),
				);
				return btwDone(
					btwResponse("response", {
						content: [
							{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "signature" },
							{ type: "text", text: "response" },
						],
					}),
				);
			},
		});
		cleanups.push(fixture.cleanup);
		await fixture.session.prompt("main question", {
			images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
		});
		const context = fixture.session.extensionRunner.createContext();
		const snapshot = await context.getContextSnapshot();
		expect(contexts).toBe(1);
		expect(snapshot.messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
		expect(JSON.stringify(snapshot.messages)).toContain("Image reading is disabled.");
		expect(JSON.stringify(snapshot.messages)).not.toContain("aW1hZ2U=");
		expect(snapshot.messages.at(-1)).toMatchObject({
			content: expect.arrayContaining([expect.objectContaining({ thinkingSignature: "signature" })]),
		});
		expect(snapshot.tools[0]).not.toHaveProperty("execute");
		expect(snapshot.tools[0].constrainedSampling).toBe(false);
		expect(Object.keys((snapshot.tools[0].parameters as TObject).properties)).toEqual(["z", "a"]);
		expect(snapshot.systemPrompt).toBe(requests[0].systemPrompt);
		const side = new BtwAgent(snapshot, fixture.modelRuntime, () => {});
		await side.ask("side question");
		expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
		expect(contexts).toBe(1);
		expect(execute).not.toHaveBeenCalled();
		side.dispose();
		// Mutating a detached snapshot cannot change the session or subsequent snapshots.
		snapshot.messages.length = 0;
		snapshot.tools[0].parameters = Type.Object({});
		expect((await context.getContextSnapshot()).messages.length).toBeGreaterThan(0);
		expect(Object.keys(((await context.getContextSnapshot()).tools[0].parameters as TObject).properties)).toEqual([
			"z",
			"a",
		]);
	});

	it("captures source state before an asynchronous context hook and re-prepares after a branch replacement", async () => {
		let release: (() => void) | undefined;
		let started = false;
		let calls = 0;
		const fixture = await createBtwTestSession({
			stream: () => btwDone(btwResponse("ok")),
			extensions: [
				(pi) => {
					pi.on("context", async (event) => {
						calls++;
						if (!started) {
							started = true;
							await new Promise<void>((resolve) => {
								release = resolve;
							});
						}
						return { messages: event.messages };
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		fixture.session.agent.state.messages = [{ role: "user", content: "source before wait", timestamp: 1 }];
		const systemPrompt = fixture.session.systemPrompt;
		const snapshotPromise = fixture.session.getContextSnapshot();
		await vi.waitFor(() => expect(started).toBe(true));
		fixture.session.agent.state.messages = [{ role: "user", content: "new branch", timestamp: 2 }];
		fixture.session.agent.state.thinkingLevel = "off";
		release!();
		const snapshot = await snapshotPromise;
		expect(snapshot.messages).toEqual([{ role: "user", content: "source before wait", timestamp: 1 }]);
		expect(snapshot.systemPrompt).toBe(systemPrompt);
		expect(snapshot.thinkingLevel).toBe("high");
		const next = await fixture.session.getContextSnapshot();
		expect(next.messages[0]).toMatchObject({ content: "new branch" });
		expect(next.thinkingLevel).toBe("off");
		expect(calls).toBe(2);
	});

	it("excludes partial assistant frames and captures request settings without the main abort signal", async () => {
		let pending: ReturnType<typeof btwPending> | undefined;
		let options: ModelsSimpleStreamOptions | undefined;
		const fixture = await createBtwTestSession({
			settings: {
				httpIdleTimeoutMs: 9876,
				websocketConnectTimeoutMs: 4321,
				retry: { provider: { maxRetries: 3, maxRetryDelayMs: 2468 } },
				transport: "websocket",
			},
			stream: (_model, _context, requestOptions) => {
				options = requestOptions;
				pending = btwPending(options?.signal);
				return pending.stream;
			},
		});
		cleanups.push(fixture.cleanup);
		const run = fixture.session.prompt("main input");
		await vi.waitFor(() => expect(pending).toBeDefined());
		pending!.text("unfinished frame");
		await vi.waitFor(() => expect(fixture.session.agent.state.streamingMessage).toBeDefined());
		const snapshot = await fixture.session.getContextSnapshot();
		expect(JSON.stringify(snapshot.messages)).not.toContain("unfinished frame");
		expect(snapshot.streamOptions).toMatchObject({
			sessionId: options?.sessionId,
			timeoutMs: 9876,
			websocketConnectTimeoutMs: 4321,
			maxRetries: 3,
			maxRetryDelayMs: 2468,
			transport: "websocket",
		});
		expect(snapshot.streamOptions).not.toHaveProperty("signal");
		expect(snapshot.streamOptions.onPayload).toBeTypeOf("function");
		expect(snapshot.streamOptions.transformHeaders).toBeTypeOf("function");
		pending!.finish("main complete");
		await run;
	});
});
