/** Start with the offline provider; /tasks-fixture-start and /tasks-fixture-finish drive gated work. */
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { startTasksScenario } from "./tasks-scenario.ts";

export default function tasksFixture(pi: ExtensionAPI): void {
	let scenario: Awaited<ReturnType<typeof startTasksScenario>> | undefined;
	pi.registerCommand("tasks-fixture-start", {
		description:"Start four offline task fixtures",
		handler:async(_args,ctx)=>{
			if(scenario){ctx.ui.notify("Task fixture already started.");return;}
			scenario=await startTasksScenario(ctx.tasks,ctx.cwd);
			ctx.ui.notify("Task fixtures ready: foreground build, failing check, cancellable shell, partial report.");
		},
	});
	pi.registerCommand("tasks-fixture-finish",{description:"Finish gated task fixtures",handler:async()=>{await scenario?.finish();}});
	pi.on("session_shutdown",async()=>{await scenario?.cleanup();scenario=undefined;});
}
