import { describe, expect, test } from "vitest";
import { summarizeCredential } from "../src/core/credential-summary.ts";

describe("summarizeCredential", () => {
	test("hints at long API keys by their last four characters only", () => {
		expect(summarizeCredential({ type: "api_key", key: "sk-demo-0000000000wxyz" })).toEqual({
			type: "api_key",
			keyHint: "wxyz",
		});
		expect(summarizeCredential({ type: "api_key", key: "short-key" })).toEqual({ type: "api_key" });
	});

	test("keeps OAuth expiry and a string account, never the tokens", () => {
		const summary = summarizeCredential({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: 1_800_000_000_000,
			email: "ming@example.com",
		});
		expect(summary).toEqual({ type: "oauth", expires: 1_800_000_000_000, account: "ming@example.com" });
		expect(JSON.stringify(summary)).not.toContain("token");
	});
});
