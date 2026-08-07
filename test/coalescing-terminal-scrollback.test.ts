import { Text, TuiMainScreen } from "@earendil-works/pi-tui";
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
		// 模拟 agent run 进行中(交互模式在 agent_start 时开启保护窗口)
		terminal.setScrollbackPreservation(true);
		const tui = new TuiMainScreen(terminal, false);
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

	it("keeps every line reachable when a full redraw grows the transcript (Ctrl+O expansion)", async () => {
		const emulator = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 1000 });
		for (let i = 0; i < 3; i++) {
			await writeToXterm(emulator, `shell-history-${i}\r\n`);
		}

		const terminal = new SizedTerminal();
		// 模拟 agent run 进行中(交互模式在 agent_start 时开启保护窗口)
		terminal.setScrollbackPreservation(true);
		const tui = new TuiMainScreen(terminal, false);
		// 交互模式同款接线:让改写路径知道屏幕顶行对应 transcript 第几行
		terminal.setViewportTopProvider(
			() => (tui as unknown as { previousViewportTop?: unknown }).previousViewportTop as number | undefined,
		);
		const texts: InstanceType<typeof Text>[] = [];
		for (let i = 0; i < 30; i++) {
			const t = new Text(`line ${i}`, 0, 0);
			texts.push(t);
			tui.addChild(t);
		}
		tui.start();
		await wait(50);

		// 模拟 Ctrl+O:展开是全局切换 —— 视口上方某处也变了一行(比如更早
		// 卡片的 hint 行),迫使 pi-tui 走 fullRender;同时视口内(30 行中的
		// 第 22 行,视口=20..29)的卡片长高 15 行,把自身头部顶出屏幕上沿。
		// 回归场景:头部这些行以前既不上屏也不进 scrollback,凭空消失。
		texts[5].setText("line 5 (toggled)");
		const details = Array.from({ length: 15 }, (_, k) => `DETAIL-${k}`);
		texts[22].setText(["line 22 EXPANDED", ...details].join("\n"));
		tui.requestRender();
		await wait(50);

		const output = captured.join("");
		tui.stop();

		// 重绘不得清 scrollback
		expect(output).not.toContain("\x1b[3J");
		expect(output).not.toContain("\x1b[2J");
		expect(tui.fullRedraws).toBeGreaterThanOrEqual(2);

		await writeToXterm(emulator, output);
		const buf = emulator.buffer.active;
		const all: string[] = [];
		for (let i = 0; i < buf.length; i++) {
			all.push(buf.getLine(i)?.translateToString(true) ?? "");
		}
		const joined = all.join("\n");

		// shell 历史仍在
		for (let i = 0; i < 3; i++) {
			expect(joined).toContain(`shell-history-${i}`);
		}
		// 展开的每一行都必须可达(屏幕或 scrollback),包括被顶出屏幕的头部
		expect(joined).toContain("line 22 EXPANDED");
		for (const detail of details) {
			expect(joined).toContain(detail);
		}
		// 已接受的权衡:屏幕上沿之上、深居 scrollback 的那处变更保持旧渲染
		// (scrollback 不可改写),但内容仍在、不会消失
		expect(joined).not.toContain("line 5 (toggled)");
		expect(joined).toContain("line 5");
		// 最终可见屏幕与上游语义的终态一致(transcript 的最后 ROWS 行)
		const contentLines = (tui as unknown as { previousLines: string[] }).previousLines;
		const expected = contentLines.slice(-ROWS).map((l) => l.replace(/\x1b\[[0-9;]*m|\x1b\]8;;\x07/g, ""));
		const viewportStart = buf.length - ROWS;
		const screen: string[] = [];
		for (let i = 0; i < ROWS; i++) {
			screen.push(buf.getLine(viewportStart + i)?.translateToString(true) ?? "");
		}
		expect(screen.map((s) => s.trimEnd())).toEqual(expected.map((s) => s.trimEnd()));
		// 缓冲区有界:3 行 shell 历史 + 45 行新 transcript + 余量,无重复副本
		expect(buf.length).toBeLessThanOrEqual(3 + 45 + ROWS);
	});
});
