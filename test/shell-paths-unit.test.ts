import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shellPathsExtension from "../src/extensions/shell-paths/index.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFile: vi.fn(),
}));
vi.mock("../src/utils/shell.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/shell.ts")>()),
	getShellConfig: vi.fn(() => ({ shell: "bash", args: ["-c"], commandTransport: "argv" as const })),
}));

const execFileMock = vi.mocked(execFile);
const realPlatform = process.platform;

/** A minimal ExtensionAPI: the extension only reads settings and subscribes to `tool_call`. */
function createPi(settings: Record<string, unknown> = {}) {
	const handlers: Array<(event: unknown) => Promise<void>> = [];
	return {
		handlers,
		getSettings: () => settings,
		on: (_event: string, handler: (event: unknown) => Promise<void>) => {
			handlers.push(handler);
		},
		async emit(event: unknown) {
			for (const handler of handlers) await handler(event);
		},
	};
}

/** Queue the mount output the next `execFile` invocation reports. */
function queueMounts(error: Error | null, stdout: string) {
	execFileMock.mockImplementationOnce(((
		_file: string,
		_args: string[],
		_options: unknown,
		callback: (error: Error | null, stdout: string) => void,
	) => {
		callback(error, stdout);
		return undefined;
	}) as unknown as typeof execFile);
}

async function callTool(pi: ReturnType<typeof createPi>, toolName: string, input: unknown): Promise<void> {
	await pi.emit({ type: "tool_call", toolName, input });
}

describe("shell-paths mount cache", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		execFileMock.mockReset();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
		vi.restoreAllMocks();
	});

	it("retries after a failed mount invocation and resolves the mounts it later reports", async () => {
		const pi = createPi();
		shellPathsExtension(pi as never);
		queueMounts(new Error("bash is still starting"), "");
		await callTool(pi, "read", { path: "/tmp/build/log.txt" });
		expect(execFileMock).toHaveBeenCalledTimes(1);

		queueMounts(null, "C:\\Users\\me\\AppData\\Local\\Temp on /tmp type ntfs (binary)\n");
		await callTool(pi, "read", { path: "/tmp/build/log.txt" });
		expect(execFileMock).toHaveBeenCalledTimes(2);
		const input = { path: "/tmp/build/log.txt" };
		await callTool(pi, "read", input);
		expect(input.path).toBe("C:\\Users\\me\\AppData\\Local\\Temp\\build\\log.txt");
	});

	it("keeps caching a valid empty mount table", async () => {
		const pi = createPi();
		shellPathsExtension(pi as never);
		queueMounts(null, "");
		const first = { path: "/tmp/one.txt" };
		const second = { path: "/tmp/two.txt" };
		await callTool(pi, "read", first);
		await callTool(pi, "read", second);
		expect(execFileMock).toHaveBeenCalledTimes(1);
		expect(first.path).toBe("/tmp/one.txt");
		expect(second.path).toBe("/tmp/two.txt");
	});

	it("ignores tool calls whose input is not an object", async () => {
		const pi = createPi();
		shellPathsExtension(pi as never);
		queueMounts(null, "C:\\Users\\me\\AppData\\Local\\Temp on /tmp type ntfs (binary)\n");
		await expect(callTool(pi, "read", null)).resolves.toBeUndefined();
		await expect(callTool(pi, "read", undefined)).resolves.toBeUndefined();
		await expect(callTool(pi, "read", "not an object")).resolves.toBeUndefined();
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("leaves drive paths and unrelated tools alone", async () => {
		const pi = createPi();
		shellPathsExtension(pi as never);
		queueMounts(null, "C:\\Users\\me\\AppData\\Local\\Temp on /tmp type ntfs (binary)\n");
		const drive = { path: "/c/Users/me/notes.txt" };
		const other = { path: "/tmp/notes.txt" };
		await callTool(pi, "bash", other);
		await callTool(pi, "read", drive);
		expect(execFileMock).not.toHaveBeenCalled();
		expect(drive.path).toBe("/c/Users/me/notes.txt");
		expect(other.path).toBe("/tmp/notes.txt");
	});
});
