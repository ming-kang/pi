import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { isAcceptableApiKey, looksTruncated } from "../src/extensions/search/key-format.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";

assert.ok(isAcceptableApiKey(`devin-session-token$${JWT}`), "full devin key accepted");
assert.ok(isAcceptableApiKey("sk-ws-01-abcdef"), "legacy sk-ws key accepted");
assert.ok(!isAcceptableApiKey(""), "empty rejected");
assert.ok(!isAcceptableApiKey("   "), "whitespace-only rejected");
assert.ok(!isAcceptableApiKey(undefined), "undefined rejected");
assert.ok(!isAcceptableApiKey(123 as unknown), "non-string rejected");

assert.ok(!looksTruncated(`devin-session-token$${JWT}`), "full devin key not flagged");
assert.ok(looksTruncated("devin-session-token"), "bare prefix flagged (whole $JWT eaten)");
assert.ok(looksTruncated("devin-session-token$"), "lone trailing $ flagged");
assert.ok(looksTruncated("devin-session-token$garbage"), "$ kept but non-JWT body flagged");
assert.ok(!looksTruncated(`  devin-session-token$${JWT}  `), "surrounding whitespace tolerated");

assert.ok(!looksTruncated("sk-ws-01-abcdef"), "legacy key never flagged");
assert.ok(!looksTruncated(""), "empty never flagged");
assert.ok(!looksTruncated(undefined), "undefined never flagged");
assert.ok(!looksTruncated("eyJonlyjwt"), "bare JWT-ish string never flagged (unknown format)");

console.log("OK key-format self-test passed");

describe("search key-format selftest", async () => {
	it("passes", async () => {});
});
