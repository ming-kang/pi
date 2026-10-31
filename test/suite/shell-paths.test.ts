import { execFileSync } from "node:child_process";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import shellPathsExtension from "../../src/extensions/shell-paths/index.ts";
import { getShellConfig } from "../../src/utils/shell.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe.skipIf(process.platform !== "win32")("shell-paths extension", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function createShellPathsHarness(): Promise<Harness> {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "write", "ls"],
			extensionFactories: [shellPathsExtension],
		});
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({});
		return harness;
	}

	it("lets file tools use the paths bash works with under its mounts", async () => {
		// Bash maps /tmp to the user's temp directory regardless of the TEMP that pi runs with.
		const dir = `/tmp/pi-shell-paths-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const shell = getShellConfig();
		cleanups.push(() => execFileSync(shell.shell, [...shell.args, `rm -rf '${dir}'`]));
		const harness = await createShellPathsHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", { command: `mkdir -p ${dir} && echo 'written by bash' > ${dir}/note.txt` }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: `${dir}/note.txt` }),
					fauxToolCall("write", { path: `${dir}/out.txt`, content: "written by pi" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("bash", { command: `cat ${dir}/out.txt` }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(getToolResult(harness, "read"))).toContain("written by bash");
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("written by pi");
	});

	it("resolves paths outside named mounts against the bash root", async () => {
		const harness = await createShellPathsHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "/usr" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = getToolResult(harness, "ls");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toContain("bin/");
	});
});
