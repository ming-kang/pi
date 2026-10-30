import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../../core/agent-session.ts";
import { createIsolatedSession } from "../../core/isolated-session.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { TaskCompletion, TaskControl } from "../../core/tasks/types.ts";
import { clipText } from "./activity.ts";
import { createMessageParentTool } from "./parent.ts";
import { AgentProgress, finalAssistantText } from "./progress.ts";
import { finalReport } from "./report.ts";
import type { AgentToolDetails } from "./types.ts";

const WORKER_TOOLS = ["read", "bash", "edit", "write", "message_parent"];

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
		"You are an Agent working independently on one delegated task.",
		"You cannot see the parent conversation. The parent Agent delegated this task to you: rely on the task briefing and available workspace context, and do not ask the end user questions. If the parent needs to know something before your final report, use message_parent; ordinary intermediate text is recorded for inspection but is not pushed.",
		"Work in the assigned directory and stay within the requested scope. Use read for known-path file reads and bash for file discovery, search, and shell commands.",
		"Do not delegate or start background work. Run required commands in the foreground and wait for them.",
		"Your final report returns to the parent automatically. Make it self-contained: include essential findings or changes, verification when applicable, blockers, and unresolved risks; omit process narration. message_parent only queues a message and never waits for a reply, so continue useful work and incorporate any later steering.",
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
	const cleanups: Array<() => void> = [];
	let session: AgentSession | undefined;
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
			customTools: [createMessageParentTool((text) => progress.sendToParent(text))],
			signal,
		});
		const worker = session;
		cleanups.push(control.channel.onSteer((text) => progress.steer(worker, text)));
		cleanups.push(
			worker.subscribe((event) => {
				// Cancellation during prompt preflight can precede the run's own abort controller.
				if (event.type === "agent_start" && signal.aborted) abort();
				else progress.handle(event);
			}),
		);
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
		for (const cleanup of cleanups) cleanup();
		session?.dispose();
	}
}
