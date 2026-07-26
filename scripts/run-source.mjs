#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const credentialVariables = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
];

const forwardedArguments = [];
let withoutCredentials = false;
for (const argument of process.argv.slice(2)) {
	if (argument === "--no-env") withoutCredentials = true;
	else forwardedArguments.push(argument);
}

const environment = { ...process.env };
if (withoutCredentials) {
	for (const name of credentialVariables) delete environment[name];
	console.log("Running without API keys...");
}

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli", { paths: [root] });
const child = spawn(
	process.execPath,
	[tsxCli, "--tsconfig", join(root, "tsconfig.json"), join(root, "src", "cli.ts"), ...forwardedArguments],
	{ stdio: "inherit", env: environment },
);
child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 1));
});
