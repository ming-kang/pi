import { Text, TUI } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescingTerminal } from "../src/utils/coalescing-terminal.ts";

const COLS = 40;
const ROWS = 10;

class SizedTerminal extends CoalescingTerminal {
	override get columns(): number {
		return COLS;
	}
	override get rows(): number {
		return ROWS;
	}
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function writeToXterm(term: InstanceType<typeof xterm.Terminal>, data: string): Promise<void> {
	return new Promise((resolve) => term.write(data, resolve));
}

describe("CoalescingTerminal scrollback preservation (e2e)", () => {
	let captured: string[];
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		captured = [];
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((data: string | Uint8Array) => {
			captured.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	it("keeps scrollback and screen state consistent across a content-driven full redraw", async () => {
		const emulator = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
		// 预置"shell 历史",模拟 Pi 启动前终端里已有的内容
		for (let i = 0; i < 5; i++) {
			await writeToXterm(emulator, `shell-history-${i}\r\n`);
		}

		const terminal = new SizedTerminal();
		const tui = new TUI(terminal, false);
		const texts: InstanceType<typeof Text>[] = [];
		for (let i = 0; i < 30; i++) {
			const t = new Text(`line ${i}`, 0, 0);
			texts.push(t);
			tui.addChild(t);
		}
		tui.start();
		await wait(50);

		// 1) 触发内容驱动的全量重绘:改一行视口上方的内容 (30 行, 视口=最后 10 行)
		texts[5].setText("line 5 CHANGED");
		tui.requestRender();
		await wait(50);

		// 2) 连续多次全量重绘不得让缓冲区无界增长(Ctrl+O 展开 + 流式的场景)
		for (let k = 0; k < 5; k++) {
			texts[6 + k].setText(`line ${6 + k} CHANGED ${k}`);
			tui.requestRender();
			await wait(40);
		}

		// 3) 之后的差分渲染必须仍然坐标正确:改视口内的一行 + 追加一行
		texts[25].setText("line 25 UPDATED");
		tui.requestRender();
		await wait(50);
		tui.addChild(new Text("line 30 appended", 0, 0));
		tui.requestRender();
		await wait(50);

		const output = captured.join("");
		tui.stop();

		// 断言 A: 输出流中不含清 scrollback 的 3J,也不含 ED 2
		// (conhost/Windows Terminal 会把 2J 实现为"把屏幕推入 scrollback",
		// 没有 3J 兜底时每次重绘都会堆一屏副本)
		expect(output).not.toContain("\x1b[3J");
		expect(output).not.toContain("\x1b[2J");
		// 确认全量重绘确实发生过(否则测试场景无效)
		expect(tui.fullRedraws).toBeGreaterThanOrEqual(6);

		// 回放到 xterm 仿真终端
		await writeToXterm(emulator, output);

		// 断言 B: 预置的 shell 历史仍在缓冲区里
		const buf = emulator.buffer.active;
		const all: string[] = [];
		for (let i = 0; i < buf.length; i++) {
			all.push(buf.getLine(i)?.translateToString(true) ?? "");
		}
		const joined = all.join("\n");
		for (let i = 0; i < 5; i++) {
			expect(joined).toContain(`shell-history-${i}`);
		}

		// 断言 C: 最终可见屏幕与 TUI 认为的内容(上游语义的屏幕终态)一致
		const contentLines = (tui as unknown as { previousLines: string[] }).previousLines;
		const expected = contentLines.slice(-ROWS).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, ""));
		const viewportStart = buf.length - ROWS;
		const screen: string[] = [];
		for (let i = 0; i < ROWS; i++) {
			screen.push(buf.getLine(viewportStart + i)?.translateToString(true) ?? "");
		}
		expect(screen.map((s) => s.trimEnd())).toEqual(expected.map((s) => s.trimEnd()));
		// 变更确实生效在屏幕上
		expect(screen.join("\n")).toContain("line 25 UPDATED");
		expect(screen.join("\n")).toContain("line 30 appended");

		// 断言 D: 缓冲区大小有界 —— 5 行 shell 历史 + 31 行内容 + 少量余量,
		// 多次全量重绘不得堆积重复副本
		expect(buf.length).toBeLessThanOrEqual(5 + 31 + ROWS);
	});
});
