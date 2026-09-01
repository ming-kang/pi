#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");

export const credentialVariables = [
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANT_LING_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEDROCK_FORCE_CACHE",
	"AWS_BEDROCK_FORCE_HTTP1",
	"AWS_BEDROCK_SKIP_AUTH",
	"AWS_CONFIG_FILE",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_DEFAULT_PROFILE",
	"AWS_DEFAULT_REGION",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_ROLE_ARN",
	"AWS_ROLE_SESSION_NAME",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_RESOURCE_NAME",
	"BASETEN_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_GATEWAY_ID",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GCLOUD_PROJECT",
	"GEMINI_API_KEY",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"LLAMA_API_KEY",
	"LLAMA_BASE_URL",
	"MINIMAX_API_HOST",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"NVIDIA_API_KEY",
	"OPENCODE_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"RADIUS_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
];

export function parseSourceArguments(args) {
	const forwardedArguments = [];
	let withoutCredentials = false;
	for (const argument of args) {
		if (argument === "--no-env") withoutCredentials = true;
		else forwardedArguments.push(argument);
	}
	return { forwardedArguments, withoutCredentials };
}

export function createSourceEnvironment(environment, withoutCredentials) {
	const result = { ...environment };
	if (withoutCredentials) {
		for (const name of credentialVariables) delete result[name];
	}
	return result;
}

export function runSource(args = process.argv.slice(2)) {
	const { forwardedArguments, withoutCredentials } = parseSourceArguments(args);
	const environment = createSourceEnvironment(process.env, withoutCredentials);
	if (withoutCredentials) console.log("Running without API keys...");

	const require = createRequire(import.meta.url);
	const tsxCli = require.resolve("tsx/cli", { paths: [root] });
	const child = spawn(
		process.execPath,
		[tsxCli, "--tsconfig", join(root, "tsconfig.json"), join(root, "src", "cli.ts"), ...forwardedArguments],
		{ stdio: "inherit", env: environment },
	);
	child.on("error", (error) => {
		console.error(`Failed to start source CLI: ${error.message}`);
		process.exitCode = 1;
	});
	child.on("exit", (code, signal) => {
		process.exitCode = signal ? 1 : (code ?? 1);
	});
}

const mainPath = process.argv[1] && resolve(process.argv[1]);
const modulePath = fileURLToPath(import.meta.url);
const isMain =
	mainPath &&
	(process.platform === "win32" ? mainPath.toLowerCase() === modulePath.toLowerCase() : mainPath === modulePath);

if (isMain) runSource();
