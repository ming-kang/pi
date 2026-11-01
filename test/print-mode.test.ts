import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";
import { backgroundSessionTest } from "./background-session-host.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	tasks: { list: () => unknown[] };
	waitForQuiescence: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		tasks: { list: () => [] },
		waitForQuiescence: vi.fn(async () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	// #10799
	it("warns on stderr and returns non-zero when the response was truncated", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ stopReason: "length" }));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe("runPrintMode with background tasks", () => {
	const { host, task } = backgroundSessionTest();

	async function setup(responses: Parameters<typeof host>[2]) {
		let execution: Awaited<ReturnType<typeof task>> | undefined;
		const session = await host(
			true,
			(pi) => {
				pi.on("session_start", async () => {
					execution = await task(session);
				});
			},
			responses,
		);
		const disposed = vi.fn();
		const runtimeHost = {
			session,
			setRebindSession: vi.fn(),
			dispose: vi.fn(async () => {
				disposed();
				session.dispose();
			}),
		};
		const stdout: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string, callback?: () => void) => {
			stdout.push(String(chunk));
			if (typeof callback === "function") callback();
			return true;
		}) as typeof process.stdout.write);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		return {
			session,
			runtimeHost: runtimeHost as unknown as Parameters<typeof runPrintMode>[0],
			stdout,
			stderr,
			disposed,
			getExecution: () => execution,
		};
	}

	it("prints the completion turn of a background task that outlives the prompt", async () => {
		const { session, runtimeHost, stdout, stderr, disposed, getExecution } = await setup([
			fauxAssistantMessage("handed off"),
			fauxAssistantMessage("worker reported back"),
		]);
		const running = runPrintMode(runtimeHost, { mode: "text", initialMessage: "start" });
		await vi.waitFor(() => expect(getExecution()).toBeDefined());
		const execution = getExecution()!;

		await vi.waitFor(() =>
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Waiting for 1 background task")),
		);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining(execution.id));
		expect(disposed).not.toHaveBeenCalled();
		expect(stdout.join("")).toBe("");
		execution.finish();

		expect(await running).toBe(0);
		expect(stdout.join("")).toBe("worker reported back\n");
		expect(session.tasks.get(execution.id).status).toBe("completed");
	});

	it("streams the completion turn and ends with session_quiescent in json mode", async () => {
		const { runtimeHost, stdout, getExecution } = await setup([
			fauxAssistantMessage("handed off"),
			fauxAssistantMessage("worker reported back"),
		]);
		const running = runPrintMode(runtimeHost, { mode: "json", initialMessage: "start" });
		await vi.waitFor(() => expect(getExecution()).toBeDefined());
		const execution = getExecution()!;
		// The prompt's own turn settled while the task still runs; the process must not exit yet.
		await vi.waitFor(() => expect(stdout.join("")).toContain('"type":"agent_settled"'));
		execution.finish();

		expect(await running).toBe(0);
		const events = stdout
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string });
		const types = events.map((event) => event.type);
		expect(types.filter((type) => type === "agent_settled")).toHaveLength(2);
		expect(types.at(-1)).toBe("session_quiescent");
		expect(types.filter((type) => type === "session_quiescent")).toHaveLength(1);
	});
});
