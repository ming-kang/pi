import { describe, expect, it } from "vitest";
import { isAcceptableApiKey, looksTruncated } from "../src/extensions/search/key-format.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";
const DEVIN_KEY = `devin-session-token$${JWT}`;

describe("isAcceptableApiKey", () => {
	it("accepts a full Devin token and a legacy sk-ws key", () => {
		expect(isAcceptableApiKey(DEVIN_KEY)).toBe(true);
		expect(isAcceptableApiKey("sk-ws-01-abcdef")).toBe(true);
	});

	it("rejects blank and non-string values", () => {
		expect(isAcceptableApiKey("")).toBe(false);
		expect(isAcceptableApiKey("   ")).toBe(false);
		expect(isAcceptableApiKey(undefined)).toBe(false);
		expect(isAcceptableApiKey(123 as unknown)).toBe(false);
	});
});

describe("looksTruncated", () => {
	it("leaves a complete Devin token alone, surrounding whitespace included", () => {
		expect(looksTruncated(DEVIN_KEY)).toBe(false);
		expect(looksTruncated(`  ${DEVIN_KEY}  `)).toBe(false);
	});

	it("flags a token whose $JWT suffix was eaten by expansion", () => {
		expect(looksTruncated("devin-session-token")).toBe(true);
		expect(looksTruncated("devin-session-token$")).toBe(true);
		expect(looksTruncated("devin-session-token$garbage")).toBe(true);
	});

	it("never flags keys in formats it does not recognize", () => {
		expect(looksTruncated("sk-ws-01-abcdef")).toBe(false);
		expect(looksTruncated("eyJonlyjwt")).toBe(false);
		expect(looksTruncated("")).toBe(false);
		expect(looksTruncated(undefined)).toBe(false);
	});
});
