import { describe, expect, test } from "vitest";
import { parseAuthCommand } from "../src/cli/auth-command.ts";

describe("auth --min-expiry", () => {
	test("keeps uppercase duration units case-insensitive", () => {
		expect(parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", "30M"])).toMatchObject({
			kind: "bearer_token",
			minExpiryMs: 30 * 60_000,
		});
		expect(parseAuthCommand(["auth", "print-bearer-token", "--min-expiry", "30S"])).toMatchObject({
			kind: "bearer_token",
			minExpiryMs: 30_000,
		});
	});
});
