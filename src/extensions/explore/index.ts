import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { defineTool } from "../../core/extensions/types.ts";
import { getMarkdownTheme } from "../../modes/interactive/theme/theme.ts";
import { boundedExploreText, type ExploreDetails, runExplore } from "./runner.ts";
import { selectExploreModel } from "./settings.ts";
import { exploreTaskView } from "./view.ts";

export function createExploreTool() {
	return defineTool({
		name: "explore",
		label: "Explore",
		description:
			"Investigate a self-contained read-only question using a temporary agent. Use for unknown locations or cross-file tracing; use read/grep/find/ls directly for known paths or exact symbols. Returns an answer with source paths, line numbers and uncertainties. Foreground waits for the report; background returns a task ID and delivers the report automatically.",
		promptSnippet: "Investigate code and return an evidence-backed report",
		parameters: Type.Object(
			{
				query: Type.String({
					minLength: 1,
					description: "Complete investigation question, including the desired evidence",
				}),
				path: Type.Optional(
					Type.String({ description: "Allowed file or directory relative to cwd; defaults to cwd" }),
				),
				background: Type.Optional(
					Type.Boolean({ description: "Return a task ID and deliver the report asynchronously" }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.query.trim() || Buffer.byteLength(params.query) > 16 * 1024)
				throw new Error("Explore query must contain text and fit within 16 KiB.");
			const setting = ctx.getExtensionSettings("explore").model;
			if (setting !== undefined && (typeof setting !== "string" || !setting.includes("/")))
				throw new Error("Invalid Explore model setting. Choose a model with /explore.");
			const slash = typeof setting === "string" ? setting.indexOf("/") : -1;
			const model =
				typeof setting === "string"
					? ctx.modelRuntime.getModel(setting.slice(0, slash), setting.slice(slash + 1))
					: ctx.model;
			if (!model) throw new Error(`Explore model is unavailable: ${setting ?? "no current model"}`);
			const request = {
				query: params.query,
				path: params.path,
				cwd: ctx.cwd,
				model: structuredClone(model),
				thinking: ctx.thinkingLevel ?? ("medium" as const),
				modelRuntime: ctx.modelRuntime,
				projectTrusted: ctx.isProjectTrusted(),
			};
			const outcome = await ctx.tasks.execute<ExploreDetails>({
				kind: "explore",
				format: "report",
				title: boundedExploreText(params.query.replace(/\s+/g, " "), 256),
				toolCallId,
				cwd: ctx.cwd,
				background: params.background,
				signal,
				onUpdate,
				run: (control) => runExplore(control, request),
			});
			if (outcome.kind === "result") return outcome.result;
			return {
				content: [
					{
						type: "text" as const,
						text: `Explore running in background: ${outcome.task.id}. The report will be delivered automatically. Use tasks read/wait/kill to inspect, wait or stop.`,
					},
				],
				details: { taskId: outcome.task.id, status: "background" },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Explore"))} ${boundedExploreText(args.query ?? "", 256)}`,
				0,
				0,
			);
		},
		renderResult(result, options, theme) {
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return options.expanded
				? new Markdown(text, 0, 0, getMarkdownTheme())
				: new Text(theme.fg("toolOutput", boundedExploreText(text, 512)), 0, 0);
		},
	});
}

export default function exploreExtension(pi: ExtensionAPI): void {
	pi.registerTool(createExploreTool());
	pi.registerCommand("explore", {
		description: "Choose the model for Explore investigations",
		handler: async (_args, ctx) => selectExploreModel(ctx),
	});
	let unregister: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unregister?.();
		unregister = ctx.tasks.views.register("explore", exploreTaskView);
	});
	pi.on("session_shutdown", () => {
		unregister?.();
		unregister = undefined;
	});
}
