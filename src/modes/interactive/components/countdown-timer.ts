/**
 * Shared deadline-based countdown timer for interactive components.
 */

import type { TUI } from "@earendil-works/pi-tui";

export class CountdownTimer {
	private timeoutId: ReturnType<typeof setTimeout> | undefined;
	private readonly deadline: number;
	private readonly tui: TUI | undefined;
	private readonly onTick: (seconds: number) => void;
	private readonly onExpire: () => void;
	private lastReportedSeconds: number | undefined;
	private disposed = false;

	constructor(timeoutMs: number, tui: TUI | undefined, onTick: (seconds: number) => void, onExpire: () => void) {
		this.tui = tui;
		this.onTick = onTick;
		this.onExpire = onExpire;
		this.deadline = Date.now() + Math.max(0, timeoutMs);
		this.report(this.remainingSeconds());
		this.scheduleNextUpdate();
	}

	private remainingMilliseconds(): number {
		return Math.max(0, this.deadline - Date.now());
	}

	private remainingSeconds(): number {
		return Math.ceil(this.remainingMilliseconds() / 1000);
	}

	private report(seconds: number): void {
		if (seconds === this.lastReportedSeconds) return;
		this.lastReportedSeconds = seconds;
		this.onTick(seconds);
	}

	private scheduleNextUpdate(): void {
		if (this.disposed) return;
		const remainingMs = this.remainingMilliseconds();
		if (remainingMs <= 0) {
			this.timeoutId = setTimeout(() => this.update(), 0);
			this.timeoutId.unref?.();
			return;
		}

		const remainingSeconds = Math.ceil(remainingMs / 1000);
		const untilNextSecond = remainingMs - (remainingSeconds - 1) * 1000;
		this.timeoutId = setTimeout(() => this.update(), Math.max(1, Math.min(remainingMs, untilNextSecond)));
		this.timeoutId.unref?.();
	}

	private update(): void {
		if (this.disposed) return;
		this.timeoutId = undefined;
		const remainingSeconds = this.remainingSeconds();
		this.report(remainingSeconds);
		this.tui?.requestRender();

		if (remainingSeconds <= 0) {
			this.dispose();
			this.onExpire();
			return;
		}
		this.scheduleNextUpdate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timeoutId !== undefined) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
	}
}
