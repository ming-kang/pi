import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
				inline: [/@earendil-works\/pi-(?:agent-core|ai|tui)/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@astralyn\/pi$/, replacement: sourceIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: sourceIndex },
			{ find: /^@mariozechner\/pi-coding-agent$/, replacement: sourceIndex },
		],
	},
});
