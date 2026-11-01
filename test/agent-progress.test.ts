import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskControl, TaskUpdate } from "../src/core/tasks/types.ts";
import { activityTarget, formatActivityDuration, relativeToCwd } from "../src/extensions/agent/activity.ts";
import { AgentProgress } from "../src/extensions/agent/progress.ts";
import { AGENT_MAX_ACTIVITIES, type AgentToolDetails } from "../src/extensions/agent/types.ts";

const cwd = resolve("/work/project");
const win = process.platform === "win32";

function progress(workdir: string | undefined = cwd) {
	const updates: TaskUpdate<AgentToolDetails>[] = [];
	const control = {
		id: "agent-1",
		signal: new AbortController().signal,
		publish: (update: TaskUpdate<AgentToolDetails>) => updates.push(update),
	} as unknown as TaskControl<AgentToolDetails>;
	const agent = new AgentProgress(control, workdir);
	let next = 0;
	const call = (toolName: string, args: unknown, end?: { durationMs: number; error?: string }) => {
		const toolCallId = `call-${next++}`;
		agent.handle({ type: "tool_execution_start", toolCallId, toolName, args } as never);
		if (!end) return;
		agent.handle({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			durationMs: end.durationMs,
			isError: end.error !== undefined,
			result: { content: [{ type: "text", text: end.error ?? "ok" }] },
		} as never);
	};
	const display = () => updates.at(-1)?.display;
	const status = () => (updates.at(-1)?.result.content[0] as { text: string }).text;
	return { agent, call, display, status, updates };
}

describe("Agent tool-call display", () => {
	it("lists calls without a header, aligning targets to the longest shown name", () => {
		const { call, display } = progress();
		call("read", { path: "README.md" }, { durationMs: 4 });
		call("bash", { command: "npm test\nnpm run check" }, { durationMs: 1500 });
		call("grep", { pattern: "needle" });
		expect(display()).toBe(["✓ read README.md · 4ms", "✓ bash npm test · 1.5s", "… grep needle"].join("\n"));
		call("powershell", { command: "Get-Date" }, { durationMs: 65_000 });
		const lines = display()?.split("\n") ?? [];
		expect(lines[0]).toBe("✓ read     README.md · 4ms");
		expect(lines[1]).toBe("✓ bash     npm test · 1.5s");
		expect(lines.at(-1)).toBe("✓ powershell Get-Date · 1m 5s");
	});

	it("counts calls that are no longer retained", () => {
		const { call, display, status } = progress();
		for (let index = 0; index < AGENT_MAX_ACTIVITIES + 3; index++)
			call("read", { path: `f${index}.ts` }, { durationMs: 1 });
		const lines = display()?.split("\n") ?? [];
		expect(lines).toHaveLength(AGENT_MAX_ACTIVITIES + 1);
		expect(lines[0]).toBe("… 3 earlier tool calls");
		expect(lines[1]).toBe("✓ read f3.ts · 1ms");
		expect(status()).toBe(`Agent running · ${AGENT_MAX_ACTIVITIES + 3} tool calls · latest: read f52.ts`);
	});

	it("shows one clipped error line under the target column", () => {
		const { call, display } = progress();
		call("read", { path: "a.ts" }, { durationMs: 2 });
		call(
			"bash",
			{ command: "make" },
			{ durationMs: 30, error: `\n  \nfirst failure line\nsecond line\n${"x".repeat(900)}` },
		);
		expect(display()?.split("\n")).toEqual(["✓ read a.ts · 2ms", "✗ bash make · 30ms", "       first failure line"]);
		call("bash", { command: "again" }, { durationMs: 30, error: "e".repeat(400) });
		const clipped = display()?.split("\n").at(-1) ?? "";
		expect(clipped.startsWith("       ")).toBe(true);
		expect(clipped.trim()).toHaveLength(160);
		expect(clipped.endsWith("…")).toBe(true);
	});

	it("shows paths inside the working directory relative, and others unchanged", () => {
		const { call, display, status } = progress();
		const inside = join(cwd, "src", "a.ts");
		const outside = resolve("/elsewhere/b.ts");
		call("read", { path: inside }, { durationMs: 1 });
		call("read", { path: outside }, { durationMs: 1 });
		call("read", { path: join("rel", "c.ts") }, { durationMs: 1 });
		expect(display()?.split("\n")).toEqual([
			"✓ read src/a.ts · 1ms",
			`✓ read ${outside} · 1ms`,
			`✓ read ${join("rel", "c.ts")} · 1ms`,
		]);
		// The model-facing status line keeps the path as the Agent wrote it.
		expect(status()).toBe(`Agent running · 3 tool calls · latest: read ${join("rel", "c.ts")}`);
		call("write", { path: inside, content: "" });
		expect(status()).toBe(`Agent running · 4 tool calls · latest: write ${inside}`);
	});

	it("publishes no display when the Agent completes", () => {
		const { agent, call } = progress();
		call("read", { path: "a.ts" }, { durationMs: 1 });
		const completion = agent.complete("completed", undefined, { text: "The report" });
		expect(completion.display).toBeUndefined();
		expect(completion.result.content).toEqual([{ type: "text", text: "The report" }]);
		expect(agent.complete("failed", "boom", { text: "Error: boom" }).display).toBeUndefined();
	});
});

describe("Agent activity targets", () => {
	it("relativizes only absolute paths inside the working directory", () => {
		expect(relativeToCwd(join(cwd, "a", "b.ts"), cwd)).toBe("a/b.ts");
		expect(relativeToCwd(cwd, cwd)).toBe(".");
		expect(relativeToCwd(resolve("/work/project-other/a.ts"), cwd)).toBe(resolve("/work/project-other/a.ts"));
		expect(relativeToCwd(resolve("/work/a.ts"), cwd)).toBe(resolve("/work/a.ts"));
		expect(relativeToCwd("a/b.ts", cwd)).toBe("a/b.ts");
		expect(relativeToCwd("../a.ts", cwd)).toBe("../a.ts");
		expect(relativeToCwd(join(cwd, "a.ts"), undefined)).toBe(join(cwd, "a.ts"));
		expect(isAbsolute(relativeToCwd(resolve("/work/a.ts"), cwd))).toBe(true);
	});

	it.runIf(win)("compares case-insensitively on Windows and keeps other drives absolute", () => {
		const workdir = String.raw`C:\work\project`;
		expect(relativeToCwd(String.raw`c:\WORK\Project\Src\a.ts`, workdir)).toBe("Src/a.ts");
		expect(relativeToCwd(String.raw`D:\work\project\a.ts`, workdir)).toBe(String.raw`D:\work\project\a.ts`);
		expect(relativeToCwd(String.raw`\work\project\a.ts`, workdir)).toBe(String.raw`\work\project\a.ts`);
	});

	it("relativizes path only where it is what is shown", () => {
		const inside = join(cwd, "src");
		expect(activityTarget("grep", { pattern: "x", path: inside }, cwd)).toBe("x");
		expect(activityTarget("grep", { path: inside }, cwd)).toBe("src");
		expect(activityTarget("find", { path: inside }, cwd)).toBe("src");
		expect(activityTarget("bash", { command: `ls ${inside}` }, cwd)).toBe(`ls ${inside}`);
	});
});

describe("Agent activity durations", () => {
	it("uses milliseconds, tenths of a second, then the shared duration form", () => {
		const text = [0, 4, 999.4, 999.6, 1000, 1500, 59_940, 59_960, 65_000, 3_600_000].map(formatActivityDuration);
		expect(text).toEqual(["0ms", "4ms", "999ms", "1.0s", "1.0s", "1.5s", "59.9s", "1m", "1m 5s", "1h"]);
		expect(formatActivityDuration(undefined)).toBe("");
	});
});
