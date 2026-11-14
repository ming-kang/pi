import { describe, expect, it, vi } from "vitest";
import { waitForNpmRelease } from "../scripts/wait-npm-release.mjs";

const name = "@astralyn/pi";
const version = "1.5.7";

function packument(hasVersion, latest = "1.5.6") {
	return new Response(
		JSON.stringify({
			"dist-tags": { latest },
			versions: hasVersion ? { [version]: { name, version } } : {},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function fixture(responses, options = {}) {
	let time = 0;
	const fetchImpl = vi.fn(async () => {
		const next = responses.length > 1 ? responses.shift() : responses[0];
		if (next instanceof Error) throw next;
		return next;
	});
	const sleepImpl = vi.fn(async (ms) => {
		time += ms;
	});
	return {
		fetchImpl,
		sleepImpl,
		options: {
			name,
			version,
			registryUrl: "https://registry.invalid",
			fetchImpl,
			now: () => time,
			sleepImpl,
			log: () => {},
			timeoutMs: 60_000,
			intervalMs: 15_000,
			...options,
		},
	};
}

describe("waitForNpmRelease", () => {
	it("waits for both the exact version and latest dist-tag", async () => {
		const { fetchImpl, sleepImpl, options } = fixture([
			new Response(null, { status: 404 }),
			packument(false),
			packument(true),
			packument(true, version),
		]);

		await expect(waitForNpmRelease(options)).resolves.toEqual({ attempts: 4, elapsedMs: 45_000 });
		expect(fetchImpl).toHaveBeenCalledTimes(4);
		expect(sleepImpl).toHaveBeenCalledTimes(3);
		expect(fetchImpl.mock.calls[0][0]).toBe("https://registry.invalid/@astralyn%2fpi");
		expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
	});

	it("retries transient HTTP and request failures", async () => {
		const { options } = fixture([
			new Response(null, { status: 429 }),
			new Response(null, { status: 503 }),
			new Error("socket reset"),
			packument(true, version),
		]);

		await expect(waitForNpmRelease(options)).resolves.toEqual({ attempts: 4, elapsedMs: 45_000 });
	});

	it("does not retry a non-retryable registry response", async () => {
		const { fetchImpl, sleepImpl, options } = fixture([new Response(null, { status: 403 })]);

		await expect(waitForNpmRelease(options)).rejects.toThrow("HTTP 403");
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(sleepImpl).not.toHaveBeenCalled();
	});

	it("times out with recovery guidance that avoids a duplicate publish", async () => {
		const { options } = fixture([new Response(null, { status: 404 })], { timeoutMs: 30_000 });

		await expect(waitForNpmRelease(options)).rejects.toThrow(
			/npm may already have accepted it; retry this wait or the CI tag job, not npm publish/,
		);
		expect(options.fetchImpl).toHaveBeenCalledTimes(3);
		expect(options.sleepImpl).toHaveBeenCalledTimes(2);
	});
});
