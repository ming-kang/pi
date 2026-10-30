import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import type { AgentSession } from "./agent-session.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { createAgentSession } from "./sdk.ts";
import { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

export interface IsolatedSessionOptions {
	cwd: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	modelRuntime: ModelRuntime;
	/** The parent's trust decision; project settings apply only when it is true. */
	projectTrusted: boolean;
	/** Builds the system prompt from the base prompt Pi would otherwise use. */
	systemPrompt: (base: string | undefined) => string;
	tools: string[];
	customTools?: ToolDefinition<any, any, any>[];
	signal?: AbortSignal;
}

/**
 * A self-contained child session for delegated work: no extensions, skills, prompt templates
 * or themes, a detached settings snapshot without cache warming, an in-memory transcript, and
 * no background tasks. Cancellation rejects, and a session created as cancellation wins is disposed.
 */
export async function createIsolatedSession(options: IsolatedSessionOptions): Promise<AgentSession> {
	const { signal } = options;
	signal?.throwIfAborted();
	const agentDir = getAgentDir();
	const prepare = async () => {
		const source = SettingsManager.create(options.cwd, agentDir, { projectTrusted: options.projectTrusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir,
			settingsManager: source,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPromptOverride: options.systemPrompt,
		});
		await resourceLoader.reload();
		// Resource discovery can reload its source; execution owns a detached snapshot, never that source.
		const settingsManager = SettingsManager.inMemory(
			{ ...source.getGlobalSettings(), cacheWarming: "off" },
			{ projectTrusted: options.projectTrusted },
		);
		settingsManager.applyOverrides(source.getProjectSettings());
		return { resourceLoader, settingsManager };
	};
	const { resourceLoader, settingsManager } = await raceWithAbortSignal(prepare(), signal);
	signal?.throwIfAborted();
	// Adopt the created session before checking cancellation; never race away its cleanup handle.
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir,
		modelRuntime: options.modelRuntime,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		backgroundAllowed: false,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(options.cwd),
		tools: options.tools,
		customTools: options.customTools,
	});
	if (signal?.aborted) {
		session.dispose();
		throw signal.reason ?? new Error("Session creation cancelled.");
	}
	return session;
}
