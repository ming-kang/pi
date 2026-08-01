import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProbeApiKey } from "../src/extensions/router/ui.ts";

describe("router catalog probe API key resolution", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("resolves literal and environment-backed keys", () => {
		vi.stubEnv("ROUTER_TEST_KEY", "secret");
		expect(resolveProbeApiKey("sk-literal")).toEqual({ value: "sk-literal" });
		expect(resolveProbeApiKey("$ROUTER_TEST_KEY")).toEqual({ value: "secret" });
		expect(resolveProbeApiKey(`\${ROUTER_TEST_KEY}`)).toEqual({ value: "secret" });
	});

	it("explains unresolved or dynamic keys instead of probing anonymously", () => {
		expect(resolveProbeApiKey("$ROUTER_MISSING_KEY").error).toContain("$ROUTER_MISSING_KEY");
		expect(resolveProbeApiKey("!secret-command").error).toContain("!command");
		expect(resolveProbeApiKey(`\${A}-$B`).error).toContain("interpolation");
	});
});
