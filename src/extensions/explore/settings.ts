import { Container, Input, SelectList, Text } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";

export async function selectExploreModel(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Explore model selection requires the interactive terminal.", "warning");
		return;
	}
	const settings = ctx.getExtensionSettings("explore");
	const current = typeof settings.model === "string" ? settings.model : "";
	const items = [
		{ value: "", label: "Follow current session" },
		...ctx.modelRuntime
			.getModels()
			.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.provider}/${model.id}` })),
	];
	const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", "Explore model"), 0, 1));
		container.addChild(new Text(theme.fg("dim", `Current: ${current || "Follow current session"}`), 0, 0));
		const input = new Input({ placeholder: "Search models" });
		const list = new SelectList(items, 12, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("dim", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("muted", text),
		});
		list.setSelectedIndex(
			Math.max(
				0,
				items.findIndex((item) => item.value === current),
			),
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		container.addChild(input);
		container.addChild(list);
		return {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data) {
				if (
					(
						[
							"tui.select.up",
							"tui.select.down",
							"tui.select.pageUp",
							"tui.select.pageDown",
							"tui.select.confirm",
							"tui.select.cancel",
						] as const
					).some((key) => keys.matches(data, key))
				)
					list.handleInput(data);
				else {
					input.handleInput(data);
					list.setFilter(input.getValue());
				}
				tui.requestRender();
			},
		};
	});
	if (selected === undefined || selected === current) return;
	try {
		const next = { ...ctx.getExtensionSettings("explore") };
		if (selected) next.model = selected;
		else delete next.model;
		await ctx.setExtensionSettings("explore", next);
		ctx.ui.notify(`Explore model: ${selected || "Follow current session"}`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not save Explore model: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}
