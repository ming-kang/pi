/** Offline, gated work shared by the task E2E and the real-terminal driver. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TasksContext } from "../../src/core/tasks/types.ts";
import { createLocalBashOperations } from "../../src/core/tools/bash.ts";
import { runShellCommand } from "../../src/core/tools/shell-execution.ts";
import type { BashToolDetails } from "../../src/core/tools/shell-tool.ts";

export async function startTasksScenario(tasks: TasksContext, cwd: string) {
	const directory = await mkdtemp(join(tmpdir(), "pi-tasks-scenario-"));
	const gate = join(directory, "finish");
	const shellGate = `'${gate.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
	const ids: string[] = [];
	const outcomes: Promise<unknown>[] = [];
	const errors: string[] = [];
	const launch = async (name: string, background: boolean, exitCode: number) => {
		const path = join(directory, `${name}.sh`);
		await writeFile(path, `for i in $(seq 90); do echo "${name} output $i"; done\nwhile [ ! -f ${shellGate} ]; do sleep 0.2; done\necho "${name} final output"\nexit ${exitCode}\n`);
		let id = "";
		const command = `bash ${name}.sh`;
		const caller = tasks.execute<BashToolDetails | undefined>({
			kind: "bash", format: "log", title: name, command, cwd: directory, toolCallId: `fixture-${name}`, background,
			run(control) {
				id = control.id;
				return runShellCommand({ operations: createLocalBashOperations(), shellName: "bash", context: { command, cwd: directory, env: { ...process.env, TASK_SCENARIO_PROJECT: cwd } }, tempFilePrefix: "pi-tasks-scenario", signal: control.signal, timeout: 600, managed: { control } });
			},
		});
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
		kind: "fixture-report", format: "report", title: "Review extension boundaries", toolCallId: "fixture-report", background: true,
		async run(control) {
			control.accept();
			control.publish({content:[{type:"text",text:"Reviewing imports and reload behavior."}],details:undefined});
			await new Promise<void>(resolve => {
				const abort = () => resolve();
				control.signal.addEventListener("abort", abort, {once:true});
				void reportGate.then(() => { control.signal.removeEventListener("abort", abort); resolve(); });
			});
			const items = [
				{id:"imports",label:"Imports",category:"review",description:"Inspect imports",status:"completed",input:"Imports",activity:"Finished",report:{text:"Public extension boundaries preserved.",truncated:false}},
				{id:"reload",label:"Reload",category:"review",description:"Inspect reload",status:"failed",input:"Reload",activity:"Finished",report:{text:"Partial reload findings.",truncated:false},error:"Fixture reload diagnostic"},
			];
			const result = { content: [{type:"text" as const,text:"Imports passed. Reload check needs attention."}], details: undefined };
			control.publish(result,{items});
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
