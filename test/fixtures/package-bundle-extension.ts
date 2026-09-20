import assert from "node:assert/strict";
import { type ExtensionAPI, SessionManager } from "@astralyn/pi";
import { normalizeContext, type OAuthCredential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** Loaded from an isolated installed package, through its bundled virtual modules. */
export default async function packageBundleSmoke(pi: ExtensionAPI): Promise<void> {
	assert.equal(typeof SessionManager.inMemory, "function");
	const providers = builtinProviders();
	const credential: OAuthCredential = {
		type: "oauth",
		access: "package-smoke-token",
		refresh: "unused",
		expires: Number.MAX_SAFE_INTEGER,
	};
	for (const id of ["anthropic", "openai-codex", "github-copilot", "openrouter", "kimi-coding", "radius", "xai"]) {
		const oauth = providers.find((provider) => provider.id === id)?.auth?.oauth;
		assert.ok(oauth, `Missing OAuth flow for ${id}`);
		// toAuth only formats this fake credential; it never logs in or refreshes it.
		const auth = await oauth.toAuth(credential);
		assert.ok(auth.apiKey || auth.headers, `OAuth flow ${id} returned no auth`);
	}

	const bedrock = providers.find((provider) => provider.id === "amazon-bedrock");
	assert.ok(bedrock);
	const model = bedrock.getModels()[0];
	assert.ok(model);
	const stopBeforeNetwork = "Package smoke reached Bedrock before network";
	const result = await bedrock
		.stream(
			{ ...model, baseUrl: "http://127.0.0.1:9" },
			normalizeContext({ messages: [{ role: "user", content: "Offline module-load check", timestamp: 0 }] }),
			{
				env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "probe", AWS_SECRET_ACCESS_KEY: "probe" },
				onPayload: () => {
					throw new Error(stopBeforeNetwork);
				},
			},
		)
		.result();
	assert.equal(result.errorMessage, stopBeforeNetwork);

	pi.registerCommand("package-smoke", { description: "Package load check completed", handler: async () => {} });
}
