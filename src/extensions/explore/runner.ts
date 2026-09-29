import { relative } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model, type Usage } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { TaskCompletion, TaskControl } from "../../core/tasks/types.ts";
import { createToolDefinitionFromAgentTool } from "../../core/tools/tool-definition-wrapper.ts";
import { truncateHead } from "../../core/tools/truncate.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { createExploreTools, resolveExploreScope } from "./scope.ts";

export interface ExploreRequest {
	query: string;
	path?: string;
	cwd: string;
	model: Model<string>;
	thinking: ThinkingLevel;
	modelRuntime: ModelRuntime;
	projectTrusted: boolean;
}

export interface ExploreDetails {
	taskId: string;
	status: string;
}

export function boundedExploreText(text: string, maxBytes = 24 * 1024): string {
	const bounded = truncateHead(text, { maxBytes: maxBytes - 32, maxLines: 2000 });
	return bounded.content + (bounded.truncated ? "\n[Explore output truncated.]" : "");
}

export async function runExplore(
	control: TaskControl<ExploreDetails>,
	request: ExploreRequest,
): Promise<TaskCompletion<ExploreDetails>> {
	const { signal } = control;
	const scope = await raceWithAbortSignal(resolveExploreScope(request.cwd, request.path), signal);
	const auth = await request.modelRuntime.getAuth(request.model, { signal });
	if (!auth) throw new Error(`No authentication for Explore model ${request.model.provider}/${request.model.id}`);
	signal.throwIfAborted();
	const thinking = clampThinkingLevel(request.model, request.thinking) as ThinkingLevel;
	const view = {
		query: request.query,
		path: relative(request.cwd, scope).replaceAll("\\", "/") || ".",
		model: `${request.model.provider}/${request.model.id}`,
		thinking,
		activities: [] as string[],
		report: "",
	};
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let lastMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
	const seen = new WeakSet<AgentMessage>();
	const publish = () => {
		control.publishView({ version: 1, data: { ...view } });
		control.publish({
			content: [{ type: "text", text: view.report || "Investigating…" }],
			details: { taskId: control.id, status: "running" },
			usage,
		});
	};
	const addUsage = (next: Usage) => {
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += next[key];
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			usage.cost[key] += next.cost[key];
		if (next.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + next.reasoning;
		if (next.cacheWrite1h !== undefined) usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + next.cacheWrite1h;
	};
	const abort = () => {
		void session?.abort().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const agentDir = getAgentDir();
		const sourceSettings = SettingsManager.create(request.cwd, agentDir, { projectTrusted: request.projectTrusted });
		const settingsManager = SettingsManager.inMemory({ ...sourceSettings.getGlobalSettings(), cacheWarming: "off" });
		settingsManager.applyOverrides(sourceSettings.getProjectSettings());
		const loader = new DefaultResourceLoader({
			cwd: request.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: [
				"You are Explore, a read-only investigation agent. Answer the supplied question with verified source evidence.",
				"You cannot see the parent conversation. Investigate using read, grep, find and ls; batch independent searches and reads.",
				`Allowed reading scope: ${scope}. Tool paths are relative to ${request.cwd}; searches default to the allowed scope.`,
				"Follow relevant references until you can answer. Recheck inconsistent evidence if files change during investigation.",
				"Do not ask the end user questions. Report blockers and uncertainties honestly. Do not delegate or modify files.",
				"Finish with a concise Markdown report: Answer, Source evidence (paths relative to the working directory, line numbers and useful symbols), and Additional information only when needed. Use the language of the question.",
			].join("\n"),
		});
		const initializing = (async () => {
			await loader.reload();
			signal.throwIfAborted();
			const created = await createAgentSession({
				cwd: request.cwd,
				agentDir,
				modelRuntime: request.modelRuntime,
				model: request.model,
				thinkingLevel: thinking,
				backgroundAllowed: false,
				resourceLoader: loader,
				settingsManager,
				sessionManager: SessionManager.inMemory(request.cwd),
				tools: ["read", "grep", "find", "ls"],
				customTools: createExploreTools(request.cwd, scope).map(createToolDefinitionFromAgentTool),
			});
			if (signal.aborted) {
				created.session.dispose();
				signal.throwIfAborted();
			}
			return created.session;
		})();
		session = await raceWithAbortSignal(initializing, signal);
		signal.throwIfAborted();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				lastMessage = event.message;
				if (!seen.has(event.message)) {
					seen.add(event.message);
					addUsage(event.message.usage);
				}
			}
			if ((event.type === "message_update" || event.type === "message_end") && event.message.role === "assistant") {
				const text = event.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (text) view.report = boundedExploreText(text);
			} else if (event.type === "tool_execution_start") {
				view.activities.push(boundedExploreText(`${event.toolName} ${JSON.stringify(event.args)}`, 512));
				if (view.activities.length > 5) view.activities.shift();
			} else if (event.type === "compaction_end" && event.result?.usage) {
				addUsage(event.result.usage);
			} else if (event.type !== "message_end") return;
			publish();
		});
		publish();
		control.accept();
		await session.prompt(request.query, { expandPromptTemplates: false });
		const status =
			signal.aborted || lastMessage?.stopReason === "aborted"
				? "cancelled"
				: !lastMessage || lastMessage.stopReason === "error" || lastMessage.stopReason === "length"
					? "failed"
					: "completed";
		const error =
			status === "cancelled"
				? "Explore cancelled."
				: status === "failed"
					? boundedExploreText(lastMessage?.errorMessage || "Explore ended without a complete answer.", 4096)
					: undefined;
		if (status === "completed") {
			view.report = boundedExploreText(
				lastMessage?.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n") ?? "",
			);
		}
		if (error) view.report = boundedExploreText(`${view.report}\n\n${error}`);
		if (!view.report) view.report = "No report returned.";
		control.publishView({ version: 1, data: { ...view } });
		return {
			status,
			error,
			usage,
			result: { content: [{ type: "text", text: view.report }], details: { taskId: control.id, status } },
		};
	} catch (error) {
		if (!session) throw error;
		const status = signal.aborted ? "cancelled" : "failed";
		const reason = boundedExploreText(
			signal.aborted ? "Explore cancelled." : error instanceof Error ? error.message : String(error),
			4096,
		);
		view.report = boundedExploreText(`${view.report}\n\n${reason}`);
		control.publishView({ version: 1, data: { ...view } });
		return {
			status,
			error: reason,
			usage,
			result: { content: [{ type: "text", text: view.report }], details: { taskId: control.id, status } },
		};
	} finally {
		signal.removeEventListener("abort", abort);
		unsubscribe?.();
		session?.dispose();
	}
}
