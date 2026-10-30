import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import { createIsolatedSession } from "../../core/isolated-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { TaskCompletion, TaskControl } from "../../core/tasks/types.ts";
import { clipText } from "./activity.ts";
import { AgentProgress, finalAssistantText } from "./progress.ts";
import { finalReport } from "./report.ts";
import type { AgentToolDetails } from "./types.ts";

const WORKER_TOOLS = ["read", "bash", "edit", "write"];

export interface AgentRequest {
	prompt: string;
	cwd: string;
	model: Model<any>;
	thinking: ThinkingLevel;
	modelRuntime: ModelRuntime;
	projectTrusted: boolean;
}

function workerPrompt(base: string | undefined): string {
	return [
		base,
		"You are an Agent completing one delegated task in an isolated session. The first user message is the complete briefing from your caller. You cannot see the caller's conversation or ask it questions. If the briefing is ambiguous, choose a reasonable interpretation within scope and report it; stop only when ambiguity blocks meaningful progress.",
		"Use the assigned working directory and stay within the requested scope. Complete the task fully without expanding it. If the briefing asks only for investigation, do not modify files. Use read for known paths and bash for discovery, search, and shell commands. Prefer editing existing files; create new files only when the task requires them, and never create documentation or report files unless explicitly requested. Do not delegate or start background work. Run required commands in the foreground and wait for them.",
		"Your final message is the only output returned to the caller. Lead with the outcome, then include essential findings, files changed if any, verification actually run and its result, and blockers or remaining risks. Cite workspace-relative paths with line numbers when useful. Respect any length limit in the briefing and omit process narration.",
	]
		.filter((part): part is string => Boolean(part?.trim()))
		.join("\n\n");
}

/** Run one delegated task in an isolated session and settle it with a self-contained report. */
export async function runWorker(
	control: TaskControl<AgentToolDetails>,
	request: AgentRequest,
): Promise<TaskCompletion<AgentToolDetails>> {
	const { signal } = control;
	const progress = new AgentProgress(control);
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	const abort = () => {
		void session?.abort().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		session = await createIsolatedSession({
			cwd: request.cwd,
			model: request.model,
			thinkingLevel: request.thinking,
			modelRuntime: request.modelRuntime,
			projectTrusted: request.projectTrusted,
			systemPrompt: workerPrompt,
			tools: WORKER_TOOLS,
			signal,
		});
		const worker = session;
		unsubscribe = worker.subscribe((event) => {
			// Cancellation during prompt preflight can precede the run's own abort controller.
			if (event.type === "agent_start" && signal.aborted) abort();
			else progress.handle(event);
		});
		progress.publish();
		control.accept();
		signal.throwIfAborted();
		await worker.prompt(request.prompt, { expandPromptTemplates: false });
		const { status, error } = progress.outcome();
		return progress.complete(status, error, await finalReport(control, finalAssistantText(worker.messages), error));
	} catch (error) {
		const status = signal.aborted ? "cancelled" : "failed";
		const reason =
			status === "cancelled"
				? "Agent cancelled."
				: clipText(error instanceof Error ? error.message : String(error), 4096);
		const report = session ? finalAssistantText(session.messages) : "";
		return progress.complete(status, reason, await finalReport(control, report, reason));
	} finally {
		signal.removeEventListener("abort", abort);
		unsubscribe?.();
		session?.dispose();
	}
}
