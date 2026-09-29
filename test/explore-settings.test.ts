import { afterEach, describe, expect, it, vi } from "vitest";
import { selectExploreModel } from "../src/extensions/explore/settings.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness;
afterEach(() => {
	harness?.cleanup();
	vi.restoreAllMocks();
});

describe("Explore model setting", () => {
	it("saves only future investigation selection and can restore follow-current", async () => {
		harness = await createHarness({ models: [{ id: "main" }, { id: "investigator" }] });
		const runner = harness.session.extensionRunner;
		const choice = `${harness.models[1]!.provider}/${harness.models[1]!.id}`;
		const custom = vi.fn().mockResolvedValueOnce(choice).mockResolvedValueOnce("");
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), custom, notify }, "tui");
		const ctx = runner.createCommandContext();
		await ctx.setExtensionSettings("other", { preserve: true });
		await selectExploreModel(ctx);
		expect(ctx.getExtensionSettings("explore")).toEqual({ model: choice });
		expect(harness.session.model?.id).toBe("main");
		await selectExploreModel(ctx);
		expect(ctx.getExtensionSettings("explore")).toEqual({});
		expect(ctx.getExtensionSettings("other")).toEqual({ preserve: true });
	});

	it("does not save on Escape and does not report success after a failed save", async () => {
		harness = await createHarness();
		const runner = harness.session.extensionRunner;
		const custom = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("test/model");
		const notify = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), custom, notify }, "tui");
		const ctx = runner.createCommandContext();
		const save = vi
			.spyOn(harness.settingsManager, "setExtensionSettings")
			.mockRejectedValue(new Error("Disk unavailable"));
		await selectExploreModel(ctx);
		expect(save).not.toHaveBeenCalled();
		await selectExploreModel(ctx);
		expect(notify).toHaveBeenCalledExactlyOnceWith("Could not save Explore model: Disk unavailable", "error");
	});

	it("rejects a captured settings context after its session is disposed", async () => {
		harness = await createHarness();
		const ctx = harness.session.extensionRunner.createContext();
		harness.session.dispose();
		expect(() => ctx.getExtensionSettings("explore")).toThrow(/stale/);
		expect(() => ctx.setExtensionSettings("explore", {})).toThrow(/stale/);
	});
});
