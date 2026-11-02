/** Offline, gated work shared by the task E2E and the real-terminal driver. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import type { TasksContext } from "../../src/core/tasks/types.ts";
import { createBashToolDefinition } from "../../src/core/tools/shell-tool.ts";

export async function startTasksScenario(tasks: TasksContext, cwd: string) {
	const directory = await mkdtemp(join(tmpdir(), "pi-tasks-scenario-"));
	const gate = join(directory, "finish");
	const shellGate = `'${gate.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
	const ids: string[] = [];
	const outcomes: Promise<unknown>[] = [];
	const errors: string[] = [];
	// The production managed shell, run in the scenario directory with the project path in its environment.
	const bash = createBashToolDefinition(directory, { exposeSessionEnvironment: false, spawnHook: (spawn) => ({ ...spawn, env: { ...spawn.env, TASK_SCENARIO_PROJECT: cwd } }) });
	const context = { tasks, cwd: directory } as unknown as ExtensionToolContext;
	const launch = async (name: string, background: boolean, exitCode: number) => {
		const path = join(directory, `${name}.sh`);
		await writeFile(path, `for i in $(seq 90); do echo "${name} output $i"; done\nwhile [ ! -f ${shellGate} ]; do sleep 0.2; done\necho "${name} final output"\nexit ${exitCode}\n`);
		const toolCallId = `fixture-${name}`;
		const caller = bash.execute(toolCallId, { command: `bash ${name}.sh`, timeout: 600, background }, undefined, undefined, context);
		// The task is registered before the tool's first await.
		const id = tasks.list().find((task) => task.toolCallId === toolCallId)?.id ?? "";
		outcomes.push(caller.catch(error => errors.push(String(error))));
		ids.push(id);
		if (background) await caller;
		return id;
	};
	const foregroundId = await launch("foreground-build", false, 0);
	const failureId = await launch("failing-check", true, 42);
	const cancelId = await launch("cancel-me", true, 0);
	let finishReport!: () => void;
	const reportGate = new Promise<void>(resolve => { finishReport = resolve; });
	const report = await tasks.execute({
		kind: "fixture-report", label: "Review", output: "report", title: "Review extension boundaries", toolCallId: "fixture-report", background: true,
		async run(control) {
			control.accept();
			control.publish({result:{content:[{type:"text",text:"Reviewing imports and reload behavior."}],details:undefined}});
			await new Promise<void>(resolve => {
				const abort = () => resolve();
				control.signal.addEventListener("abort", abort, {once:true});
				void reportGate.then(() => { control.signal.removeEventListener("abort", abort); resolve(); });
			});
			const result = { content: [{type:"text" as const,text:"Imports: public extension boundaries preserved.\nReload: partial findings; Fixture reload diagnostic."}], details: undefined };
			control.publish({result});
			return {status:control.signal.aborted?"cancelled" as const:"partial" as const,result};
		},
	});
	if(report.kind!=="background") throw new Error("Expected report handoff");
	ids.push(report.task.id);
	return {
		foregroundId, failureId, cancelId, reportId:report.task.id, errors,
		async finish(){await writeFile(gate, "done");finishReport();},
		async cleanup(){
			await writeFile(gate,"done");finishReport();
			for(const id of ids){try{tasks.kill(id);}catch{/* A replaced runtime already owns shutdown. */}}
			await Promise.all(outcomes);
			await rm(directory,{recursive:true,force:true});
		},
	};
}
