import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import {
	type BackgroundRegistryOptions,
	BackgroundTaskRegistry,
	type BgStallNotification,
	type BgTaskNotification,
	createOutputFileExclusively,
	looksLikePrompt,
	readOutputSince,
	readOutputSlice,
} from "../src/extensions/background/registry.ts";

interface FakeExecCall {
	command: string;
	cwd: string;
	timeout: number | undefined;
	env: NodeJS.ProcessEnv | undefined;
	signal: AbortSignal | undefined;
	emitData: (text: string | Buffer) => void;
	finish: (exitCode: number | null) => void;
	fail: (error: Error) => void;
}

function createFakeOperations(): { operations: BashOperations; calls: FakeExecCall[] } {
	const calls: FakeExecCall[] = [];
	const operations: BashOperations = {
		exec: (command, cwd, options) =>
			new Promise((resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				calls.push({
					command,
					cwd,
					timeout: options.timeout,
					env: options.env,
					signal: options.signal,
					emitData: (text) => options.onData(Buffer.isBuffer(text) ? text : Buffer.from(text)),
					finish: (exitCode) => resolve({ exitCode }),
					fail: (error) => reject(error),
				});
			}),
	};
	return { operations, calls };
}

const tempDirs: string[] = [];

function makeRegistry(overrides?: Partial<BackgroundRegistryOptions>): {
	registry: BackgroundTaskRegistry;
	calls: FakeExecCall[];
	notifications: BgTaskNotification[];
	onNotify: ReturnType<typeof vi.fn>;
	onChange: ReturnType<typeof vi.fn>;
	outputDir: string;
} {
	const { operations, calls } = createFakeOperations();
	const outputDir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
	tempDirs.push(outputDir);
	const notifications: BgTaskNotification[] = [];
	const onNotify = vi.fn((notification: BgTaskNotification) => {
		notifications.push(notification);
	});
	const onChange = vi.fn();
	const registry = new BackgroundTaskRegistry({
		operations,
		outputDir,
		onNotify,
		onChange,
		...overrides,
	});
	return { registry, calls, notifications, onNotify, onChange, outputDir };
}

/**
 * Stall-watchdog harness: real (tiny) timers with an injected fake clock for
 * the threshold arithmetic; assertions poll with vi.waitFor. (Fake timers
 * cannot drive the libuv thread-pool completion that readOutputSlice's async
 * file I/O depends on.)
 */
function makeStallRegistry() {
	let clock = 1_000_000;
	const stalls: BgStallNotification[] = [];
	const onStall = vi.fn((notification: BgStallNotification) => {
		stalls.push(notification);
	});
	const base = makeRegistry({
		onStall,
		now: () => clock,
		stall: { pollIntervalMs: 5, thresholdMs: 15, tailBytes: 1_024 },
	});
	/** Jump the injected clock forward by ms (the real 5ms timer keeps ticking). */
	const advance = async (ms: number) => {
		clock += ms;
		await new Promise((resolve) => setTimeout(resolve, Math.max(20, ms / 5) * 1));
	};
	const setClock = (ms: number) => {
		clock = ms;
	};
	return { ...base, stalls, onStall, advance, setClock };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("BackgroundTaskRegistry", () => {
	it("runs a task to completion and notifies with the flushed output", async () => {
		const { registry, calls, notifications, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "echo hi", cwd: "/work" });

		expect(task.status).toBe("running");
		expect(task.id).toMatch(/^bg-[0-9a-f]{6}$/);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("echo hi");
		expect(calls[0]?.cwd).toBe("/work");

		calls[0]?.emitData("line one\n");
		calls[0]?.emitData("line two\n");

		let fileAtNotifyTime = "";
		onNotify.mockImplementationOnce((notification: BgTaskNotification) => {
			fileAtNotifyTime = readFileSync(notification.task.outputPath, "utf8");
			notifications.push(notification);
		});
		calls[0]?.finish(0);
		const finished = await registry.waitForTask(task.id);

		expect(finished.status).toBe("completed");
		expect(finished.exitCode).toBe(0);
		expect(finished.endedAt).toBeDefined();
		expect(onNotify).toHaveBeenCalledTimes(1);
		// The notification only fires after the stream is flushed.
		expect(fileAtNotifyTime).toBe("line one\nline two\n");
		expect(notifications[0]?.tailText).toBe("line one\nline two\n");
		expect(notifications[0]?.tailTruncated).toBe(false);
	});

	it("classifies a non-zero exit as failed", async () => {
		const { registry, calls } = makeRegistry();
		const task = registry.startTask({ command: "false", cwd: "/work" });
		calls[0]?.finish(2);
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("failed");
		expect(finished.error).toContain("code 2");
	});

	it("kills a running task via abort and classifies it as killed", async () => {
		const { registry, calls, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "sleep 100", cwd: "/work" });

		const result = registry.killTask(task.id);
		expect(result.killed).toBe(true);
		expect(calls[0]?.signal?.aborted).toBe(true);

		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("killed");
		expect(onNotify).toHaveBeenCalledTimes(1);

		expect(registry.killTask(task.id)).toEqual({ killed: false, reason: "not-running" });
		expect(registry.killTask("bg-nope")).toEqual({ killed: false, reason: "not-found" });
	});

	it("classifies an ops timeout as timeout", async () => {
		const { registry, calls } = makeRegistry();
		const task = registry.startTask({ command: "sleep 100", cwd: "/work", timeoutSeconds: 5 });
		expect(calls[0]?.timeout).toBe(5);
		calls[0]?.fail(new Error("timeout:5"));
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("timeout");
		expect(finished.error).toContain("5s");
	});

	it("reports a spawn failure as failed with the error message", async () => {
		const { registry, calls, notifications } = makeRegistry();
		const task = registry.startTask({ command: "boom", cwd: "/missing" });
		calls[0]?.fail(new Error("Working directory does not exist: /missing"));
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("failed");
		expect(finished.error).toContain("/missing");
		expect(notifications[0]?.task.id).toBe(task.id);
	});

	it("kills the task when output exceeds the byte limit", async () => {
		const { registry, calls } = makeRegistry({ maxOutputBytes: 64 });
		const task = registry.startTask({ command: "yes", cwd: "/work" });

		calls[0]?.emitData("a".repeat(50));
		calls[0]?.emitData("b".repeat(50));
		expect(calls[0]?.signal?.aborted).toBe(true);
		// Data after the overflow is dropped.
		calls[0]?.emitData("c".repeat(50));

		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("failed");
		expect(finished.outputTruncated).toBe(true);
		expect(finished.error).toContain("limit");

		const content = readFileSync(finished.outputPath, "utf8");
		expect(content.startsWith(`${"a".repeat(50)}${"b".repeat(14)}`)).toBe(true);
		expect(content).toContain("output limit");
		expect(content).not.toContain("ccc");
	});

	it("keeps the overflow verdict when the exec promise later rejects", async () => {
		const { registry, calls, onNotify } = makeRegistry({ maxOutputBytes: 8 });
		const task = registry.startTask({ command: "yes", cwd: "/work" });
		calls[0]?.emitData("x".repeat(32));
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("failed");
		expect(finished.error).toContain("limit");
		expect(onNotify).toHaveBeenCalledTimes(1);
	});

	it("preserves completion and settlement when onNotify throws", async () => {
		const { registry, calls, onNotify } = makeRegistry();
		onNotify.mockImplementationOnce(() => {
			throw new Error("stale runtime");
		});
		const task = registry.startTask({ command: "echo hi", cwd: "/work" });
		calls[0]?.finish(0);
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("completed");
		expect(onNotify).toHaveBeenCalledOnce();
	});

	it("shutdown mutes notifications, kills running tasks, and refuses new ones", async () => {
		const { registry, calls, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "sleep 100", cwd: "/work" });

		await registry.shutdown();

		expect(calls[0]?.signal?.aborted).toBe(true);
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("killed");
		expect(onNotify).not.toHaveBeenCalled();
		expect(() => registry.startTask({ command: "echo", cwd: "/work" })).toThrow(/shutting down/);
		// Idempotent.
		await registry.shutdown();
	});

	it("enforces the running-task limit", () => {
		const { registry } = makeRegistry({ maxRunningTasks: 2 });
		registry.startTask({ command: "a", cwd: "/w" });
		registry.startTask({ command: "b", cwd: "/w" });
		expect(() => registry.startTask({ command: "c", cwd: "/w" })).toThrow(/limit 2/);
	});

	it("resolves tasks by id prefix with and without the bg- prefix", async () => {
		const { registry, calls } = makeRegistry();
		const task = registry.startTask({ command: "echo", cwd: "/w" });
		const hex = task.id.slice("bg-".length);

		expect(registry.resolveTask(task.id)).toEqual({ ok: true, task });
		expect(registry.resolveTask(hex)).toEqual({ ok: true, task });
		expect(registry.resolveTask(hex.slice(0, 3))).toEqual({ ok: true, task });
		expect(registry.resolveTask("zzz")).toMatchObject({ ok: false, reason: "not-found" });

		const second = registry.startTask({ command: "echo", cwd: "/w" });
		const shared = registry.resolveTask("bg-");
		expect(shared).toMatchObject({ ok: false, reason: "ambiguous" });
		if (!shared.ok) expect(shared.candidates).toHaveLength(2);

		calls[0]?.finish(0);
		calls[1]?.finish(0);
		await registry.waitForTask(task.id);
		await registry.waitForTask(second.id);
	});

	it("orders the task list with running first, then newest finished", async () => {
		let clock = 1000;
		const { registry, calls } = makeRegistry({ now: () => clock++ });
		const first = registry.startTask({ command: "first", cwd: "/w" });
		const second = registry.startTask({ command: "second", cwd: "/w" });
		const third = registry.startTask({ command: "third", cwd: "/w" });

		calls[0]?.finish(0);
		await registry.waitForTask(first.id);
		calls[1]?.finish(1);
		await registry.waitForTask(second.id);

		const ids = registry.listTasks().map((task) => task.id);
		expect(ids).toEqual([third.id, second.id, first.id]);
		expect(registry.counts()).toMatchObject({ running: 1, completed: 1, failed: 1, total: 3 });

		calls[2]?.finish(0);
		await registry.waitForTask(third.id);
	});

	it("passes the caller-provided environment through to exec", async () => {
		const { registry, calls } = makeRegistry();
		const task = registry.startTask({ command: "env", cwd: "/w", env: { PI_SESSION_ID: "sess-1", FOO: "bar" } });
		expect(calls[0]?.env).toMatchObject({ PI_SESSION_ID: "sess-1", FOO: "bar" });
		calls[0]?.finish(0);
		await registry.waitForTask(task.id);
	});

	it("still notifies with tailError when the output file cannot be read", async () => {
		const { registry, calls, notifications, outputDir } = makeRegistry();
		const task = registry.startTask({ command: "echo hi", cwd: "/w" });
		// Redirect the recorded path to a missing file: the stream keeps writing
		// to the original fd, but the notification's tail read hits ENOENT.
		task.outputPath = join(outputDir, "missing.log");
		calls[0]?.finish(0);

		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("completed");
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.tailError).toMatch(/ENOENT|no such file/i);
		expect(notifications[0]?.tailText).toBe("");
	});

	it("marks the notification tail as truncated when output exceeds the tail budget", async () => {
		const { registry, calls, notifications } = makeRegistry({ notifyTailBytes: 8 });
		const task = registry.startTask({ command: "seq", cwd: "/w" });
		calls[0]?.emitData("0123456789abcdefghij");
		calls[0]?.finish(0);

		await registry.waitForTask(task.id);
		const notification = notifications[0];
		expect(notification?.tailText).toBe("cdefghij");
		expect(notification?.tailBytes).toBe(8);
		expect(notification?.totalBytes).toBe(20);
		expect(notification?.tailTruncated).toBe(true);
		expect(notification?.tailStartsMidLine).toBe(true);
	});

	it("claim: a registered waiter delivers the completion and suppresses the followUp", async () => {
		const { registry, calls, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "echo hi", cwd: "/w" });
		calls[0]?.emitData("output\n");

		const waitPromise = registry.waitForResult(task.id, 5_000);
		calls[0]?.finish(0);
		const result = await waitPromise;

		expect(result.outcome).toBe("terminal");
		expect(result.task.status).toBe("completed");
		await registry.waitForTask(task.id);
		expect(onNotify).not.toHaveBeenCalled();
	});

	it("claim: a kill while waiting is delivered inline without a followUp", async () => {
		const { registry, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "sleep 100", cwd: "/w" });

		const waitPromise = registry.waitForResult(task.id, 5_000);
		registry.killTask(task.id);
		const result = await waitPromise;

		expect(result.outcome).toBe("terminal");
		expect(result.task.status).toBe("killed");
		await registry.waitForTask(task.id);
		expect(onNotify).not.toHaveBeenCalled();
	});

	it("timeout: the wait window expiring leaves the followUp untouched", async () => {
		const { registry, calls, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "sleep 100", cwd: "/w" });

		const result = await registry.waitForResult(task.id, 20);
		expect(result.outcome).toBe("timeout");
		expect(result.task.status).toBe("running");
		expect(onNotify).not.toHaveBeenCalled();

		calls[0]?.finish(0);
		await registry.waitForTask(task.id);
		expect(onNotify).toHaveBeenCalledTimes(1);
	});

	it("waiting on an already-finished task returns the terminal state directly", async () => {
		const { registry, calls, onNotify } = makeRegistry();
		const task = registry.startTask({ command: "echo hi", cwd: "/w" });
		calls[0]?.finish(0);
		await registry.waitForTask(task.id);

		const result = await registry.waitForResult(task.id, 20);
		expect(result.outcome).toBe("terminal");
		expect(result.task.status).toBe("completed");
		// The followUp for this completion already fired — the direct read is an
		// idempotent repeat, not a second notification.
		expect(onNotify).toHaveBeenCalledTimes(1);
	});

	it("waitForResult rejects for an unknown task id", async () => {
		const { registry } = makeRegistry();
		await expect(registry.waitForResult("bg-nope", 20)).rejects.toThrow(/Unknown background task/);
	});

	it("creates the output file exclusively before the task is returned", async () => {
		const { registry, calls } = makeRegistry();
		const task = registry.startTask({ command: "echo hi", cwd: "/w" });
		// Synchronous exclusive create: the file exists empty from the moment
		// startTask returns, and the stream only ever appends to it.
		expect(readFileSync(task.outputPath, "utf8")).toBe("");
		calls[0]?.emitData("written\n");
		await vi.waitFor(() => expect(readFileSync(task.outputPath, "utf8")).toBe("written\n"));
	});
});

describe("readOutputSlice", () => {
	function writeTempFile(content: string | Buffer): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-slice-"));
		tempDirs.push(dir);
		const filePath = join(dir, "out.log");
		writeFileSync(filePath, content);
		return filePath;
	}

	it("reads the head of a file", async () => {
		const filePath = writeTempFile("abcdefghij");
		const slice = await readOutputSlice(filePath, { mode: "head", maxBytes: 4 });
		expect(slice.text).toBe("abcd");
		expect(slice.truncated).toBe(true);
		expect(slice.totalBytes).toBe(10);
		expect(slice.startsMidLine).toBe(false);
	});

	it("reads the tail and reports mid-line starts", async () => {
		const filePath = writeTempFile("line one\nline two\n");
		const midLine = await readOutputSlice(filePath, { mode: "tail", maxBytes: 5 });
		expect(midLine.text).toBe(" two\n");
		expect(midLine.startsMidLine).toBe(true);

		const atBoundary = await readOutputSlice(filePath, { mode: "tail", maxBytes: 9 });
		expect(atBoundary.text).toBe("line two\n");
		expect(atBoundary.startsMidLine).toBe(false);
	});

	it("does not split multi-byte characters at the tail boundary", async () => {
		// "→" is three bytes (E2 86 92); maxBytes 7 would start mid-character.
		const filePath = writeTempFile("→→→→");
		const slice = await readOutputSlice(filePath, { mode: "tail", maxBytes: 7 });
		expect(slice.text).toBe("→→");
		expect(slice.text).not.toContain("�");
		expect(slice.truncated).toBe(true);
	});

	it("handles empty files and whole-file reads", async () => {
		const empty = await readOutputSlice(writeTempFile(""), { mode: "tail", maxBytes: 100 });
		expect(empty).toMatchObject({ text: "", sliceBytes: 0, totalBytes: 0, truncated: false });

		const whole = await readOutputSlice(writeTempFile("hi\n"), { mode: "tail", maxBytes: 100 });
		expect(whole).toMatchObject({ text: "hi\n", truncated: false, startsMidLine: false });
	});

	it("rejects when the file does not exist", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-slice-"));
		tempDirs.push(dir);
		await expect(readOutputSlice(join(dir, "missing.log"), { mode: "tail", maxBytes: 10 })).rejects.toThrow();
	});
});

describe("looksLikePrompt", () => {
	it("matches the interactive-prompt patterns on the last line", () => {
		for (const tail of [
			"Install? (y/n)",
			"Proceed? [y/N]",
			"choose (yes/no)",
			"Do you want to continue?",
			"Would you like to proceed? ",
			"Press any key to continue",
			"Press Enter to confirm",
			"Continue?",
			"Overwrite?",
		]) {
			expect(looksLikePrompt(tail)).toBe(true);
		}
	});

	it("does not match merely-slow output", () => {
		for (const tail of ["Refactoring modules…", "", "42% complete", "Building (no question)"]) {
			expect(looksLikePrompt(tail)).toBe(false);
		}
	});

	it("only tests the last non-empty line", () => {
		expect(looksLikePrompt("earlier Continue?\nCompiling module 7 of 9")).toBe(false);
		expect(looksLikePrompt("Compiling module 7 of 9\nOverwrite?")).toBe(true);
	});
});

describe("stall watchdog", () => {
	it("fires once when output stalls on a prompt-looking tail", async () => {
		const { registry, calls, stalls, onStall, advance } = makeStallRegistry();
		const task = registry.startTask({ command: "npm install", cwd: "/w" });
		calls[0]?.emitData("downloading…\nProceed? (y/n) ");
		await vi.waitFor(() => expect(readFileSync(task.outputPath, "utf8")).toContain("(y/n)"));

		await advance(40);
		await vi.waitFor(() => expect(stalls).toHaveLength(1));
		expect(stalls[0]?.task.id).toBe(task.id);
		expect(stalls[0]?.tailText).toContain("(y/n)");
		expect(task.stalled).toBe(true);
		expect(registry.counts().stalled).toBe(1);

		// One-shot latch: further stall windows never re-notify.
		await advance(60);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("stays silent for merely-slow tasks without prompt tails", async () => {
		const { registry, calls, stalls, advance } = makeStallRegistry();
		registry.startTask({ command: "git log -S foo", cwd: "/w" });
		calls[0]?.emitData("searching revisions…");
		await advance(300);
		expect(stalls).toHaveLength(0);
	});

	it("clears the stalled flag when output resumes without re-notifying", async () => {
		const { registry, calls, stalls, advance } = makeStallRegistry();
		const task = registry.startTask({ command: "npm install", cwd: "/w" });
		calls[0]?.emitData("Proceed? (y/n) ");
		// Wait for the flush before jumping the clock: the growth check reads
		// task.outputBytes, which the async stream has not yet counted otherwise.
		await vi.waitFor(() => expect(readFileSync(task.outputPath, "utf8")).toContain("(y/n)"));
		await advance(40);
		await vi.waitFor(() => expect(stalls).toHaveLength(1));

		calls[0]?.emitData("resumed work\n");
		await advance(20);
		expect(task.stalled).toBe(false);

		// Stall again: flag returns, notification does not.
		await advance(100);
		expect(task.stalled).toBe(true);
		expect(stalls).toHaveLength(1);
	});

	it("does not trigger while output keeps growing", async () => {
		const { registry, calls, stalls, advance } = makeStallRegistry();
		registry.startTask({ command: "yes | head", cwd: "/w" });
		for (let i = 0; i < 8; i++) {
			calls[0]?.emitData(`tick ${i}\n`);
			await advance(30);
		}
		expect(stalls).toHaveLength(0);
	});

	it("stall then complete: completion notification is unaffected", async () => {
		const { registry, calls, stalls, notifications, advance } = makeStallRegistry();
		const task = registry.startTask({ command: "npm install", cwd: "/w" });
		calls[0]?.emitData("Proceed? (y/n) ");
		await vi.waitFor(() => expect(readFileSync(task.outputPath, "utf8")).toContain("(y/n)"));
		await advance(40);
		await vi.waitFor(() => expect(stalls).toHaveLength(1));

		calls[0]?.finish(0);
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("completed");
		expect(finished.stalled).toBe(false);
		expect(notifications).toHaveLength(1);
	});

	it("stall then kill: normal terminal path, no duplicate stall", async () => {
		const { registry, calls, stalls, onNotify, advance } = makeStallRegistry();
		const task = registry.startTask({ command: "npm install", cwd: "/w" });
		// No output at all: an empty, non-growing file is a legitimate stall probe
		// only when it looks like a prompt — empty tail does not, so this test
		// needs a prompt tail too. (Empty file never stalls; keep a real tail.)
		calls[0]?.emitData("Proceed? (y/n) ");
		await vi.waitFor(() => expect(readFileSync(task.outputPath, "utf8")).toContain("(y/n)"));
		await advance(40);
		await vi.waitFor(() => expect(stalls).toHaveLength(1));

		registry.killTask(task.id);
		const finished = await registry.waitForTask(task.id);
		expect(finished.status).toBe("killed");
		expect(onNotify).toHaveBeenCalledTimes(1);
		await advance(50);
		expect(stalls).toHaveLength(1);
	});

	it("shutdown stops the watchdog and stays silent", async () => {
		const { registry, stalls, advance } = makeStallRegistry();
		registry.startTask({ command: "npm install", cwd: "/w" });
		await advance(20);
		await registry.shutdown();
		await advance(100);
		expect(stalls).toHaveLength(0);
	});

	it("still notifies with tailError when the output file cannot be read", async () => {
		const { registry, stalls, outputDir, advance } = makeStallRegistry();
		const task = registry.startTask({ command: "npm install", cwd: "/w" });
		// Redirect the recorded path so the stall probe hits ENOENT: a read
		// failure still notifies (with tailError) even though no tail exists.
		task.outputPath = join(outputDir, "missing.log");
		await advance(60);
		await vi.waitFor(() => expect(stalls).toHaveLength(1));
		expect(stalls[0]?.tailError).toMatch(/ENOENT|no such file/i);
	});
});

describe("exclusive output file creation", () => {
	it("fails with EEXIST when the path already exists as a regular file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-wx-"));
		tempDirs.push(dir);
		const filePath = join(dir, "existing.log");
		writeFileSync(filePath, "precious");
		expect(() => createOutputFileExclusively(filePath)).toThrow(/EEXIST/);
		expect(readFileSync(filePath, "utf8")).toBe("precious");
	});

	it("fails with EEXIST when the path is a symlink and leaves the target intact", () => {
		// Creating symlinks on Windows needs elevated privileges; the property
		// (EEXIST on any existing path, symlink included) is POSIX-defined.
		if (process.platform === "win32") return;
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-wx-"));
		tempDirs.push(dir);
		const target = join(dir, "target.log");
		const link = join(dir, "link.log");
		writeFileSync(target, "do not truncate");
		symlinkSync(target, link);

		expect(() => createOutputFileExclusively(link)).toThrow(/EEXIST/);
		expect(readFileSync(target, "utf8")).toBe("do not truncate");
	});

	it("creates an empty file on a fresh path", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-wx-"));
		tempDirs.push(dir);
		const filePath = join(dir, "fresh.log");
		createOutputFileExclusively(filePath);
		expect(readFileSync(filePath, "utf8")).toBe("");
	});
});

describe("readOutputSince", () => {
	function writeTempFile(content: string | Buffer): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-bg-since-"));
		tempDirs.push(dir);
		const filePath = join(dir, "out.log");
		writeFileSync(filePath, content);
		return filePath;
	}

	it("returns the whole delta when it fits the budget", async () => {
		const filePath = writeTempFile("0123456789");
		const slice = await readOutputSince(filePath, 4, 100);
		expect(slice.text).toBe("456789");
		expect(slice.fromByte).toBe(4);
		expect(slice.truncated).toBe(false);
		expect(slice.totalBytes).toBe(10);
	});

	it("tail-aligns and reports truncation when the delta exceeds the budget", async () => {
		const filePath = writeTempFile("0123456789");
		const slice = await readOutputSince(filePath, 0, 4);
		expect(slice.text).toBe("6789");
		expect(slice.fromByte).toBe(6);
		expect(slice.truncated).toBe(true);
	});

	it("clamps an offset at or beyond EOF to an empty read", async () => {
		const filePath = writeTempFile("0123456789");
		const atEof = await readOutputSince(filePath, 10, 100);
		expect(atEof).toMatchObject({ text: "", sliceBytes: 0, truncated: false, fromByte: 10 });

		const pastEof = await readOutputSince(filePath, 99, 100);
		expect(pastEof).toMatchObject({ text: "", sliceBytes: 0, truncated: false, fromByte: 10 });
	});

	it("reports mid-line starts when the delta begins mid-line", async () => {
		const filePath = writeTempFile("line one\nline two\n");
		const midLine = await readOutputSince(filePath, 4, 100);
		expect(midLine.text).toBe(" one\nline two\n");
		expect(midLine.startsMidLine).toBe(true);

		const atBoundary = await readOutputSince(filePath, 9, 100);
		expect(atBoundary.text).toBe("line two\n");
		expect(atBoundary.startsMidLine).toBe(false);
	});

	it("handles empty files and a zero offset", async () => {
		const empty = await readOutputSince(writeTempFile(""), 0, 100);
		expect(empty).toMatchObject({ text: "", sliceBytes: 0, totalBytes: 0, truncated: false });

		const whole = await readOutputSince(writeTempFile("hi\n"), 0, 100);
		expect(whole).toMatchObject({ text: "hi\n", truncated: false, startsMidLine: false, fromByte: 0 });
	});
});
