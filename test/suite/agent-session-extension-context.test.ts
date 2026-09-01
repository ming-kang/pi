import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ShellSettings } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession extension context wiring", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("exposes live shell settings through the canonical runner context", async () => {
		let context: ExtensionContext | undefined;
		const harness = await createHarness({
			settings: {
				shellPath: "/bin/custom-shell",
				shellCommandPrefix: "source ~/.profile",
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						context = ctx;
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({});
		const getShellSettings = context?.getShellSettings;
		if (!getShellSettings) throw new Error("session_start did not expose getShellSettings");
		expect(getShellSettings()).toEqual({
			shellPath: "/bin/custom-shell",
			commandPrefix: "source ~/.profile",
		});

		harness.settingsManager.applyOverrides({
			shellPath: "/bin/reloaded-shell",
			shellCommandPrefix: "export TEST=1",
		});
		expect(getShellSettings()).toEqual({
			shellPath: "/bin/reloaded-shell",
			commandPrefix: "export TEST=1",
		} satisfies ShellSettings);
	});
});
