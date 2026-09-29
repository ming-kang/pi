import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory, ToolDefinition } from "../../src/core/extensions/index.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { btwModel } from "./btw.ts";

export async function createBtwTestSession(options: {
	stream: ProviderStreams["streamSimple"];
	extensions?: ExtensionFactory[];
	settings?: Partial<Settings>;
	tools?: ToolDefinition[];
	persist?: boolean;
	model?: typeof btwModel;
}) {
	const model = options.model ?? btwModel;
	const directory = mkdtempSync(join(tmpdir(), "pi-btw-test-"));
	const sessionsDirectory = join(directory, "sessions");
	mkdirSync(sessionsDirectory);
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "btw-test-key",
		models: [model],
		streamSimple: options.stream,
	});
	const extensionsResult = await createTestExtensionsResult(options.extensions ?? [], directory);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, ...options.settings });
	const sessionManager = options.persist
		? SessionManager.create(directory, sessionsDirectory)
		: SessionManager.inMemory(directory);
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		modelRuntime,
		model,
		thinkingLevel: "high",
		settingsManager,
		sessionManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		customTools: options.tools,
		tools: options.tools?.map((tool) => tool.name) ?? [],
	});
	return {
		session,
		sessionManager,
		settingsManager,
		modelRuntime,
		sessionsDirectory,
		async cleanup() {
			await session.abort();
			session.dispose();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
