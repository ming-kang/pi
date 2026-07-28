#!/usr/bin/env node

import { resolve } from "node:path";
import { runDiffUpstream } from "./diff-upstream-core.mjs";

process.exitCode = runDiffUpstream({
	root: resolve(import.meta.dirname, ".."),
	args: process.argv.slice(2),
	stdout: process.stdout,
	stderr: process.stderr,
});
