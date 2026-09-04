/**
 * Presentation for the edit tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `edit.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { EditToolDetails } from "../edit.ts";
import { computeEditsDiff, type Edit, type EditDiffError, type EditDiffResult } from "../edit-diff.ts";
import { collapsedLinesHint, renderToolPath, str } from "../render-utils.ts";

type EditPreview = EditDiffResult | EditDiffError;
export type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};
type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};
type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};
class EditCallRenderComponent extends Container {
	preview: EditPreview | undefined;
	previewArgsKey: string | undefined;
	previewPending = false;
}
function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof EditCallRenderComponent) {
		state.callComponent = lastComponent;
		return lastComponent;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = new EditCallRenderComponent();
	state.callComponent = component;
	return component;
}
function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}
function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}
const EDIT_COLLAPSED_DIFF_LINES = 10;
function diffStat(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}
function formatDiffStat(diff: string, theme: Theme): string {
	const { added, removed } = diffStat(diff);
	return ` ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`;
}
function boundDiffBody(renderedDiff: string, expanded: boolean, theme: Theme): string {
	if (expanded) return renderedDiff;
	const lines = renderedDiff.split("\n");
	if (lines.length <= EDIT_COLLAPSED_DIFF_LINES) return renderedDiff;
	const shown = lines.slice(0, EDIT_COLLAPSED_DIFF_LINES);
	const remaining = lines.length - shown.length;
	return `${shown.join("\n")}\n${collapsedLinesHint(theme, remaining, "more")}`;
}
function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
	expanded: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return boundDiffBody(renderDiff(resultDiff, { filePath: rawPath ?? undefined }), expanded, theme);
	}

	return undefined;
}
function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	expanded: boolean,
): EditCallRenderComponent {
	component.clear();

	const preview = component.preview;
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	let headline = formatEditCall(args, theme, cwd);
	if (previewDiff !== undefined) headline += formatDiffStat(previewDiff, theme);
	component.addChild(new Text(headline, 0, 0));

	if (!preview) {
		return component;
	}

	const body =
		"error" in preview ? theme.fg("error", preview.error) : boundDiffBody(renderDiff(preview.diff), expanded, theme);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}
function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export const editRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const component = getEditCallRenderComponent(context.state, context.lastComponent);
		const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
		const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;

		if (component.previewArgsKey !== argsKey) {
			component.preview = undefined;
			component.previewArgsKey = argsKey;
			component.previewPending = false;
		}

		if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
			component.previewPending = true;
			const requestKey = argsKey;
			void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
				if (component.previewArgsKey === requestKey) {
					setEditPreview(component, preview, requestKey);
					context.invalidate();
				}
			});
		}

		return buildEditCallComponent(
			component,
			args as RenderableEditArgs | undefined,
			theme,
			context.cwd,
			context.expanded,
		);
	},
	renderResult(result, options, theme, context) {
		const callComponent = context.state.callComponent;
		const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
		const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;
		const typedResult = result as EditToolResultLike;
		const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
		let changed = false;
		if (callComponent) {
			if (typeof resultDiff === "string") {
				changed =
					setEditPreview(
						callComponent,
						{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
						argsKey,
					) || changed;
			}
			if (changed) {
				buildEditCallComponent(
					callComponent,
					context.args as RenderableEditArgs | undefined,
					theme,
					context.cwd,
					context.expanded,
				);
			}
		}

		const output = formatEditResult(
			context.args as RenderableEditArgs | undefined,
			callComponent?.preview,
			typedResult,
			theme,
			context.isError,
			options.expanded,
		);
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (!output) {
			return component;
		}
		component.addChild(new Spacer(1));
		component.addChild(new Text(output, 1, 0));
		return component;
	},
};
