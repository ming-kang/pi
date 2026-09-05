import { readFileSync, rmSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundService } from "../src/core/background/service.ts";
import { SUBAGENT_BACKGROUND_REJECTION } from "../src/core/background/types.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition, MAX_BACKGROUND_OUTPUT_BYTES } from "../src/core/tools/bash.ts";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { runRead, runWait } from "../src/extensions/background/actions.ts";

const services: BackgroundService[] = [];
const paths = new Set<string>();
function host(options: ConstructorParameters<typeof BackgroundService>[0] = { enabled: true }) {
	const background = new BackgroundService(options);
	services.push(background);
	background.subscribe(() => {
		for (const task of background.list()) if (task.outputPath) paths.add(task.outputPath);
	});
	return background;
}
function context(background: BackgroundService): ExtensionContext {
	return {
		background,
		cwd: process.cwd(),
		model: { provider: "provider", id: "model" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "session", getSessionFile: () => "session.jsonl" },
	} as unknown as ExtensionContext;
}
function execution() {
	let options!: Parameters<BashOperations["exec"]>[2];
	let resolve!: (value: { exitCode: number | null }) => void;
	let reject!: (error: Error) => void;
	const exec = vi.fn<BashOperations["exec"]>((_command, _cwd, supplied) => {
		options = supplied;
		return new Promise((yes, no) => {
			resolve = yes;
			reject = no;
			supplied.signal?.addEventListener("abort", () => no(new Error("aborted")), { once: true });
		});
	});
	return {
		operations: { exec },
		get options() {
			return options;
		},
		output: (text: string | Buffer) => options.onData(Buffer.isBuffer(text) ? text : Buffer.from(text)),
		finish: (exitCode: number | null = 0) => resolve({ exitCode }),
		fail: (error: string) => reject(new Error(error)),
	};
}
function text(result: { content: Array<{ type: string; text?: string }> } | undefined) {
	return result?.content.map((part) => part.text ?? "").join("\n") ?? "";
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.shutdown();
	for (const path of paths) rmSync(path, { force: true });
	paths.clear();
	vi.useRealTimers();
});

describe("native managed shell execution", () => {
	it.each(["startup", "exit"] as const)("never reports immediate %s failure as completed success", async (mode) => {
		const background = host();
		const diagnostic = mode === "startup" ? "spawn failed" : "Command exited with code 42";
		const exec = vi.fn<BashOperations["exec"]>(() =>
			mode === "startup" ? Promise.reject(new Error(diagnostic)) : Promise.resolve({ exitCode: 42 }),
		);
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec } });
		const outcome = await tool
			.execute("call", { command: "fast", background: true }, undefined, undefined, context(background))
			.then(
				(result) => ({ result, error: undefined }),
				(error: unknown) => ({ result: undefined, error }),
			);
		if (outcome.result) {
			expect(outcome.result.details?.background?.kind).toBe("background");
			const task = await background.wait(outcome.result.details!.background!.taskId);
			expect(task).toMatchObject({ status: "failed", error: diagnostic });
		} else expect(outcome.error).toMatchObject({ status: "failed", message: diagnostic });
		expect(exec).toHaveBeenCalledOnce();
	});

	it.each([
		["startup", "failed", "spawn failed"],
		["exit", "failed", "Command exited with code 42"],
		["timeout", "timeout", "Command timed out after 2 seconds"],
		["abort", "cancelled", "Command aborted"],
		["success", "completed", undefined],
	] as const)("preserves %s when completion wins before handoff", async (mode, status, diagnostic) => {
		const background = host();
		// Hold acceptance at the service boundary to deterministically exercise completion winning,
		// including asynchronous output-file closure before Bash returns its completion.
		const execute = background.execute.bind(background);
		vi.spyOn(background, "execute").mockImplementation((request) =>
			execute({ ...request, run: (control) => request.run({ ...control, accept: () => {} }) }),
		);
		const exec = vi.fn<BashOperations["exec"]>(() => {
			if (mode === "startup") return Promise.reject(new Error("spawn failed"));
			if (mode === "timeout") return Promise.reject(new Error("timeout:2"));
			if (mode === "abort") return Promise.reject(new Error("aborted"));
			return Promise.resolve({ exitCode: mode === "exit" ? 42 : 0 });
		});
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec } });
		const call = tool.execute(
			"call",
			{ command: "fast", background: true },
			undefined,
			undefined,
			context(background),
		);
		if (diagnostic)
			await expect(call).rejects.toMatchObject({ name: "BackgroundExecutionError", status, message: diagnostic });
		else {
			const result = await call;
			expect(text(result)).toBe("(no output)");
			expect(result.details?.background).toBeUndefined();
		}
		expect(background.list()[0]?.status).toBe(status);
		expect(background.detachForeground()).toBe(0);
		expect(background.pendingNotifications()).toEqual([]);
		expect(exec).toHaveBeenCalledOnce();
	});

	it.each([createBashToolDefinition, createPowerShellToolDefinition])(
		"rejects unavailable background requests before hooks or operations (%#)",
		async (factory) => {
			const spawnHook = vi.fn((value) => value);
			const exec = vi.fn<BashOperations["exec"]>(async () => ({ exitCode: 0 }));
			const tool = factory(process.cwd(), { operations: { exec }, spawnHook });
			await expect(
				tool.execute("call", { command: "noop", background: true }, undefined, undefined, undefined as never),
			).rejects.toThrow("No command was started");
			await expect(
				tool.execute(
					"call",
					{ command: "noop", background: true },
					undefined,
					undefined,
					context(host({ enabled: false })),
				),
			).rejects.toThrow("not available");
			await expect(
				tool.execute(
					"call",
					{ command: "noop", background: true },
					undefined,
					undefined,
					context(host({ enabled: true, role: "subagent" })),
				),
			).rejects.toThrow(SUBAGENT_BACKGROUND_REJECTION);
			expect(spawnHook).not.toHaveBeenCalled();
			expect(exec).not.toHaveBeenCalled();
		},
	);

	it("worker foreground commands preserve the standalone path", async () => {
		const background = host({ enabled: true, role: "subagent" });
		const tool = createBashToolDefinition(process.cwd(), {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("ok"));
					return { exitCode: 0 };
				},
			},
		});
		const result = await tool.execute(
			"call",
			{ command: "noop", background: false },
			undefined,
			undefined,
			context(background),
		);
		expect(text(result)).toBe("ok");
		expect(result.details).toBeUndefined();
		expect(background.list()).toEqual([]);
	});

	it("detaches a silent command immediately, executes once, and keeps the owned signal and timeout", async () => {
		const background = host();
		const child = execution();
		const parent = new AbortController();
		const update = vi.fn();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const pending = tool.execute(
			"call",
			{ command: "silent", timeout: 12 },
			parent.signal,
			update,
			context(background),
		);
		expect(background.detachForeground()).toBe(1);
		expect(background.detachForeground()).toBe(0);
		const result = await pending;
		const id = result.details!.background!.taskId;
		expect(result.details?.background?.kind).toBe("background");
		expect(result.details).not.toHaveProperty("exitCode");
		expect(readFileSync(result.details!.fullOutputPath!, "utf8")).toBe("");
		expect(child.operations.exec).toHaveBeenCalledTimes(1);
		expect(child.options.timeout).toBe(12);
		expect(child.options.signal).not.toBe(parent.signal);
		const count = update.mock.calls.length;
		parent.abort();
		expect(child.options.signal?.aborted).toBe(false);
		child.output("still running\n");
		expect((await background.read(id)).text).toBe("still running\n");
		child.finish();
		expect((await background.wait(id)).status).toBe("completed");
		expect(update).toHaveBeenCalledTimes(count);
	});

	it.each([createBashToolDefinition, createPowerShellToolDefinition])(
		"explicitly manages both shell factories and preserves hook environment (%#)",
		async (factory) => {
			const background = host();
			const child = execution();
			const spawnHook = vi.fn(({ command, cwd, env }) => ({
				command: `hook\n${command}`,
				cwd,
				env: { ...env, HOOK: "yes" },
			}));
			const tool = factory(process.cwd(), { operations: child.operations, spawnHook });
			const result = await tool.execute(
				"call",
				{ command: "work", background: true },
				undefined,
				undefined,
				context(background),
			);
			expect(spawnHook).toHaveBeenCalledTimes(1);
			expect(child.operations.exec.mock.calls[0][0]).toBe("hook\nwork");
			expect(child.options.env).toMatchObject({
				HOOK: "yes",
				PI_SESSION_ID: "session",
				PI_SESSION_FILE: "session.jsonl",
				PI_PROVIDER: "provider",
				PI_MODEL: "model",
				PI_REASONING_LEVEL: "high",
			});
			child.output("héllo €");
			const id = result.details!.background!.taskId;
			expect((await background.read(id)).text).toBe("héllo €");
			child.finish();
			const final = await background.wait(id);
			expect(text(final.result)).toBe("héllo €");
			expect(final.status).toBe("completed");
			expect(final.result?.details).toEqual({ fullOutputPath: result.details?.fullOutputPath });
		},
	);

	it("publishes a recent bounded tail continuously without an original update observer", async () => {
		vi.useFakeTimers();
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const result = await tool.execute(
			"call",
			{ command: "work", background: true },
			undefined,
			undefined,
			context(background),
		);
		const id = result.details!.background!.taskId;
		child.output("x".repeat(60 * 1024));
		child.output("\nLATEST\n");
		await vi.advanceTimersByTimeAsync(100);
		const projection = background.get(id).projection!.text!;
		expect(projection).toContain("LATEST");
		expect(Buffer.byteLength(projection)).toBeLessThanOrEqual(16 * 1024);
		child.finish();
		const final = await background.wait(id);
		expect(text(final.result)).toContain("LATEST");
		expect(text(final.result)).toContain("Full output:");
	});

	it("resolves prefix, cwd and environment only once across handoff", async () => {
		const background = host();
		const child = execution();
		const spawnHook = vi.fn(({ command, env }) => ({ command, cwd: "hook-cwd", env }));
		const tool = createBashToolDefinition("factory-cwd", {
			operations: child.operations,
			commandPrefix: "setup",
			spawnHook,
		});
		const pending = tool.execute("call", { command: "work" }, undefined, undefined, context(background));
		background.detachForeground();
		await pending;
		expect(child.operations.exec.mock.calls[0].slice(0, 2)).toEqual(["setup\nwork", "hook-cwd"]);
		expect(spawnHook).toHaveBeenCalledTimes(1);
		child.finish();
	});

	it("parent abort before execution starts never invokes the hook", async () => {
		const background = host();
		const spawnHook = vi.fn((value) => value);
		const child = execution();
		const controller = new AbortController();
		controller.abort();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations, spawnHook });
		await expect(
			tool.execute("call", { command: "noop" }, controller.signal, undefined, context(background)),
		).rejects.toThrow();
		expect(spawnHook).not.toHaveBeenCalled();
		expect(child.operations.exec).not.toHaveBeenCalled();
	});

	it("foreground abort throws the final output; background kill settles cancellation", async () => {
		const background = host();
		const child = execution();
		const parent = new AbortController();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const pending = tool.execute("call", { command: "work" }, parent.signal, undefined, context(background));
		child.output("before abort");
		parent.abort();
		await expect(pending).rejects.toThrow("before abort\n\nCommand aborted");
		const result = await tool.execute(
			"next",
			{ command: "work", background: true },
			undefined,
			undefined,
			context(background),
		);
		const id = result.details!.background!.taskId;
		background.kill(id);
		expect((await background.wait(id)).status).toBe("cancelled");
	});

	it("keeps the original timeout deadline across detach", async () => {
		vi.useFakeTimers();
		const background = host();
		const exec = vi.fn<BashOperations["exec"]>(
			(_command, _cwd, { timeout }) =>
				new Promise((_resolve, reject) =>
					setTimeout(() => reject(new Error(`timeout:${timeout}`)), timeout! * 1000),
				),
		);
		const tool = createBashToolDefinition(process.cwd(), { operations: { exec } });
		const pending = tool.execute(
			"call",
			{ command: "silent", timeout: 12 },
			undefined,
			undefined,
			context(background),
		);
		await vi.advanceTimersByTimeAsync(5000);
		background.detachForeground();
		const result = await pending;
		await vi.advanceTimersByTimeAsync(7000);
		const task = background.get(result.details!.background!.taskId);
		expect(task.status).toBe("timeout");
		expect(task.error).toBe("Command timed out after 12 seconds");
		expect(text(await runRead(background, { action: "read", taskId: task.id }))).toContain(task.error);
		expect(text(task.result)).toContain("timed out after 12 seconds");
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it.each([42, null])("does not report exit %s as a managed success", async (exitCode) => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const result = await tool.execute(
			"call",
			{ command: "work", background: true },
			undefined,
			undefined,
			context(background),
		);
		child.output("partial output");
		child.finish(exitCode);
		const final = await background.wait(result.details!.background!.taskId);
		expect(final.status).toBe("failed");
		expect(text(final.result)).toContain("partial output");
		const diagnostic = exitCode === null ? "Command terminated without an exit code" : "Command exited with code 42";
		expect(final.error).toBe(diagnostic);
		const read = text(await runRead(background, { action: "read", taskId: final.id }));
		expect(read).toContain(diagnostic);
		expect(read).toContain("partial output");
		expect(read.indexOf(diagnostic)).toBeLessThan(read.indexOf("partial output"));
		expect(
			text(
				await runWait(background, {
					action: "wait",
					taskId: final.id,
					sinceBytes: Buffer.byteLength("partial output"),
				}),
			),
		).toContain(diagnostic);
		expect(background.pendingNotifications().map((task) => task.id)).toEqual([final.id]);
	});

	it("caps background disk output and aborts with a failure rather than a false cancellation", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const result = await tool.execute(
			"call",
			{ command: "chatty", background: true },
			undefined,
			undefined,
			context(background),
		);
		child.output(Buffer.alloc(MAX_BACKGROUND_OUTPUT_BYTES + 20, 120));
		const final = await background.wait(result.details!.background!.taskId);
		expect(final.status).toBe("failed");
		expect(child.options.signal?.aborted).toBe(true);
		expect(statSync(result.details!.fullOutputPath!).size).toBe(MAX_BACKGROUND_OUTPUT_BYTES);
		expect(final.error).toBe("Background command exceeded the 20 MiB output limit");
		const read = text(await runRead(background, { action: "read", taskId: final.id, bytes: 50 * 1024 }));
		expect(read).toContain(final.error);
		expect(Buffer.byteLength(read)).toBeLessThanOrEqual(50 * 1024);
		// The core bounds final results, so the status is authoritative even when the tail fills its budget.
		expect(Buffer.byteLength(text(final.result))).toBeLessThanOrEqual(48 * 1024);
	});

	it("bounds failure reasons independently of command output", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const result = await tool.execute(
			"call",
			{ command: "work", background: true },
			undefined,
			undefined,
			context(background),
		);
		child.output("raw log\n".repeat(6000));
		child.fail(`failure reason ${"界".repeat(6000)}`);
		const final = await background.wait(result.details!.background!.taskId);
		expect(final.error).toMatch(/^failure reason /);
		expect(final.error).not.toContain("raw log");
		expect(Buffer.byteLength(final.error!)).toBeLessThanOrEqual(4096);
	});

	it("does not impose the background cap on managed foreground output", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const pending = tool.execute("call", { command: "chatty" }, undefined, undefined, context(background));
		child.output(Buffer.alloc(MAX_BACKGROUND_OUTPUT_BYTES + 1, 120));
		expect(child.options.signal?.aborted).toBe(false);
		child.finish();
		const result = await pending;
		expect(statSync(result.details!.fullOutputPath!).size).toBe(MAX_BACKGROUND_OUTPUT_BYTES + 1);
	});

	it("stops on managed output write failure without throwing from the data observer", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const result = await tool.execute(
			"call",
			{ command: "work", background: true },
			undefined,
			undefined,
			context(background),
		);
		const append = vi.spyOn(OutputAccumulator.prototype, "append").mockImplementationOnce(() => {
			throw new Error("disk write failed");
		});
		try {
			expect(() => child.output("lost output")).not.toThrow();
			const final = await background.wait(result.details!.background!.taskId);
			expect(final.status).toBe("failed");
			expect(text(final.result)).toContain("disk write failed");
			expect(child.options.signal?.aborted).toBe(true);
		} finally {
			append.mockRestore();
		}
	});

	it("checks already oversized foreground output on silent detach without deleting prior output", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const pending = tool.execute("call", { command: "chatty" }, undefined, undefined, context(background));
		child.output(Buffer.alloc(MAX_BACKGROUND_OUTPUT_BYTES + 1, 120));
		background.detachForeground();
		const result = await pending;
		expect(child.options.signal?.aborted).toBe(true);
		const task = await background.wait(result.details!.background!.taskId);
		expect(task.status).toBe("failed");
		expect(text(task.result)).toContain("20 MiB output limit");
		expect(statSync(task.outputPath!).size).toBe(MAX_BACKGROUND_OUTPUT_BYTES + 1);
	});

	it("foreground timeout still throws while its core snapshot records timeout", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const call = tool.execute("call", { command: "work", timeout: 3 }, undefined, undefined, context(background));
		child.output("not a timeout: output text");
		child.fail("timeout:3");
		await expect(call).rejects.toThrow("Command timed out after 3 seconds");
		expect(background.list()[0]?.status).toBe("timeout");
		expect(text(background.list()[0]?.result)).toContain("not a timeout: output text");
	});

	it("late output errors use the captured host, never the reloaded context getter", async () => {
		const background = host();
		const child = execution();
		const ctx = context(background);
		const getter = vi.fn(() => background);
		Object.defineProperty(ctx, "background", { get: getter, configurable: true });
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const result = await tool.execute("call", { command: "work", background: true }, undefined, undefined, ctx);
		getter.mockImplementation(() => {
			throw new Error("stale context");
		});
		const append = vi.spyOn(OutputAccumulator.prototype, "append").mockImplementationOnce(() => {
			throw new Error("disk failed after reload");
		});
		try {
			expect(() => child.output("late")).not.toThrow();
			const final = await background.wait(result.details!.background!.taskId);
			expect(final.status).toBe("failed");
			expect(text(final.result)).toContain("disk failed after reload");
			expect(getter).toHaveBeenCalledOnce();
		} finally {
			append.mockRestore();
		}
	});

	it("cleans only managed files on shutdown and cannot restart a closed captured host", async () => {
		const background = host();
		const child = execution();
		const tool = createBashToolDefinition(process.cwd(), { operations: child.operations });
		const call = tool.execute("call", { command: "work" }, undefined, undefined, context(background));
		child.output("persisted final");
		child.finish();
		const result = await call;
		const path = result.details!.fullOutputPath!;
		expect(readFileSync(path, "utf8")).toBe("persisted final");
		await background.shutdown();
		expect(() => statSync(path)).toThrow();
		expect(text(background.list()[0]?.result)).toBe("persisted final");
		await expect(tool.execute("new", { command: "work" }, undefined, undefined, context(background))).rejects.toThrow(
			"closed",
		);
		expect(child.operations.exec).toHaveBeenCalledOnce();
	});

	it("managed accumulator preserves split UTF-8 in one continuously readable exclusive file", async () => {
		const output = new OutputAccumulator({ persistFromStart: true });
		const path = output.snapshot().fullOutputPath!;
		paths.add(path);
		const euro = Buffer.from("€");
		output.append(euro.subarray(0, 1));
		expect(readFileSync(path)).toEqual(euro.subarray(0, 1));
		output.append(euro.subarray(1));
		expect(output.snapshot().content).toBe("€");
		expect(output.snapshot().truncation.truncated).toBe(false);
		output.finish();
		await output.closeTempFile();
		expect(readFileSync(path, "utf8")).toBe("€");
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});
