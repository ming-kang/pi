import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { loadRouterInstallationId } from "../../../src/extensions/router/state.ts";

// This fixture only receives an allowlisted environment and a disposable agent directory.
const directory = process.env.PI_CODING_AGENT_DIR;
if (!directory || !process.send) throw new Error("An isolated directory and IPC are required");
const path = join(directory, "router-client.json");
const mode = process.argv[2];
const send = (type: string, value?: string) => process.send?.({ type, value });
const command = () => new Promise<void>((resolve) => process.once("message", () => resolve()));

// Observe a real filesystem lock collision, rather than guessing with sleeps.
const originalMkdir = fs.mkdir;
let reportedBlocked = false;
fs.mkdir = ((...args: Parameters<typeof fs.mkdir>) => {
	const callback = args.pop() as (error: NodeJS.ErrnoException | null) => void;
	originalMkdir(args[0], (error) => {
		if (error?.code === "EEXIST" && String(args[0]) === `${path}.lock` && !reportedBlocked) {
			reportedBlocked = true;
			send("blocked");
		}
		callback(error);
	});
}) as typeof fs.mkdir;

const originalWrite = promises.writeFile;
if (mode === "fail-write") {
	promises.writeFile = async (target, _data, options) => {
		await originalWrite(target, "{", options);
		throw Object.assign(new Error("injected write failure"), { code: "EIO" });
	};
}
if (mode === "fail-rename") {
	promises.rename = async () => {
		throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
	};
}
if (mode === "pause-write") {
	promises.writeFile = async (target, data, options) => {
		await originalWrite(target, "{", options);
		const resume = command();
		send("partial");
		await resume;
		await originalWrite(target, data, { encoding: "utf8", mode: 0o600 });
	};
}
const originalLock = lockfile.lock;
lockfile.lock = async (target, options) => {
	// proper-lockfile normally uses a cloned graceful-fs object; inject the observed native fs.
	const release = await originalLock(target, { ...options, fs });
	if (mode === "compromised") {
		promises.writeFile = async (...args) => {
			await originalWrite(...args);
			options?.onCompromised?.(Object.assign(new Error("injected compromised lock"), { code: "ECOMPROMISED" }));
		};
		syncBuiltinESMExports();
	}
	return release;
};
syncBuiltinESMExports();

try {
	const start = command();
	send("ready");
	await start;
	if (mode === "hold") {
		const release = await lockfile.lock(path, { realpath: false, stale: 30_000 });
		const resume = command();
		send("held");
		await resume;
		await release();
		send("released");
	} else {
		send("result", await loadRouterInstallationId());
	}
} catch (error) {
	send("error", error instanceof Error ? error.message : String(error));
} finally {
	process.disconnect();
}
