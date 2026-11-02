import { describe, expect, it, vi } from "vitest";
import { QuiescenceLatch } from "../src/core/quiescence.ts";

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("QuiescenceLatch", () => {
	it("never reports a quiet moment inside a transition and reports each quiet period once", async () => {
		let busy = true;
		const onQuiescent = vi.fn();
		const latch = new QuiescenceLatch(() => busy, onQuiescent);
		latch.poke();
		// Looks quiet midway, busy again before the transition ends.
		busy = false;
		latch.poke();
		busy = true;
		await tick();
		expect(onQuiescent).not.toHaveBeenCalled();

		busy = false;
		latch.poke();
		latch.poke();
		await tick();
		latch.poke();
		await tick();
		expect(onQuiescent).toHaveBeenCalledOnce();
	});

	it("resolves a waiter that saw unobserved busy work, but not while a quiescence listener restarts work", async () => {
		let busy = true;
		let restart = true;
		const latch = new QuiescenceLatch(
			() => busy,
			() => {
				if (!restart) return;
				restart = false;
				busy = true;
				latch.poke();
			},
		);
		const resolved = vi.fn();
		const waiting = latch.wait().then(resolved);
		busy = false;
		latch.poke();
		await tick();
		expect(resolved).not.toHaveBeenCalled();

		busy = false;
		latch.poke();
		await waiting;
		expect(resolved).toHaveBeenCalledOnce();
	});
});
