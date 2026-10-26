import { type Component, Container } from "@earendil-works/pi-tui";
import type {
	ToolDefinition,
	ToolExecutionShell,
	ToolRenderContext,
	ToolRenderers,
} from "../../../core/extensions/types.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { createAllToolRenderers } from "../../../core/tools/renderers/index.ts";
import { createCallFallback, FallbackResultComponent } from "./fallback.ts";
import { FramedComponent, toolMarkerColor, toolStatus, toolStyle } from "./style.ts";

export type ToolDefinitionLike = ToolRenderers | ToolDefinition<any, any, any>;

let builtInRenderers: ReturnType<typeof createAllToolRenderers> | undefined;

function builtInResultRenderer(toolName: string): ToolRenderers["renderResult"] {
	builtInRenderers ??= createAllToolRenderers();
	return (builtInRenderers as Record<string, ToolRenderers>)[toolName]?.renderResult;
}

/**
 * Create the distribution's TUI chrome without changing a tool's call or result renderers.
 * The native component invokes these fallbacks only when the corresponding renderer slot is empty
 * or fails. HTML export never reads this object.
 */
export function createToolShell(toolName: string, definition: ToolDefinitionLike | undefined): ToolExecutionShell {
	const resultRenderer = definition?.renderResult;
	return {
		get gap() {
			return toolStyle.gap;
		},
		frame(component: Component, kind: "header" | "body", context: ToolRenderContext): Component {
			return new FramedComponent(component, kind, () => toolMarkerColor(toolStatus(context)));
		},
		renderCall(args, _theme, context) {
			return createCallFallback(toolName, args, context.expanded);
		},
		renderResult(result, _options, _theme, context) {
			const output = getRenderedTextOutput(result, context.showImages);
			return output ? new FallbackResultComponent(output, context.expanded) : new Container();
		},
		shouldHideResult(context) {
			if (context.expanded || context.isError || !toolStyle.collapsed.headerOnly.has(toolName)) return false;
			const builtIn = builtInResultRenderer(toolName);
			// Only fold the built-in result renderer. An extension that replaces it owns its collapsed view.
			return builtIn !== undefined && builtIn === resultRenderer;
		},
	};
}

/**
 * Attach the distribution shell while preserving renderer identity and explicit shell ownership.
 * In particular, this does not set renderShell or wrap renderCall/renderResult, so HTML export and
 * other renderer resolvers continue to see the original functions.
 */
export function withToolShell(toolName: string, definition: ToolDefinitionLike | undefined): ToolDefinitionLike {
	if (definition?.renderShell === "self" || definition?.shell) return definition;
	return { ...(definition ?? {}), shell: createToolShell(toolName, definition) };
}
