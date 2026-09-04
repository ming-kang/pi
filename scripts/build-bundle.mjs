#!/usr/bin/env node

/**
 * Bundles the executable entrypoints into self-contained single files with
 * esbuild, overwriting the tsc output at dist/cli.js and dist/rpc-entry.js.
 * The tsc output remains the SDK/library surface (dist/index.js, dist/client,
 * .d.ts); only the two bin entrypoints and the image-resize worker are
 * bundled, so cold starts read one file instead of hundreds.
 *
 * Native/WASM dependencies stay external and resolve from node_modules at
 * runtime. All other runtime assets (themes, export-html templates, docs)
 * stay external files handled by the copy-assets step and config.ts path
 * resolution, which already special-cases the dist layout.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src");

// pi-ai loads OAuth flow modules through variable dynamic imports that
// bundlers cannot follow; registerBunOAuthFlows registers them statically.
// The prelude must be the entry module so registration runs at startup.
const ENTRY_PRELUDE = `#!/usr/bin/env node
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
registerBunOAuthFlows();
`;

const bundledEntryPlugin = {
	name: "pi-bundled-entry",
	setup(build) {
		build.onResolve({ filter: /^pi-bundled-entry:/ }, (args) => ({
			path: args.path,
			namespace: "pi-bundled-entry",
		}));
		build.onLoad({ filter: /.*/, namespace: "pi-bundled-entry" }, (args) => ({
			contents: `${ENTRY_PRELUDE}import ${JSON.stringify(`./${args.path.slice("pi-bundled-entry:".length)}`)};`,
			resolveDir: srcDir,
			loader: "ts",
		}));
	},
};

const result = await esbuild.build({
	entryPoints: [
		{ in: "pi-bundled-entry:cli.ts", out: "cli" },
		{ in: "pi-bundled-entry:rpc-entry.ts", out: "rpc-entry" },
		{ in: "src/utils/image-resize-worker.ts", out: "image-resize-worker" },
	],
	outdir: "dist",
	absWorkingDir: rootDir,
	platform: "node",
	format: "esm",
	target: "node22",
	bundle: true,
	splitting: false,
	// src/core/extensions/loader.ts switches user-extension loading to
	// embedded virtualModules when this is defined.
	define: { PI_BUNDLED_NODE: "true" },
	external: ["@silvia-odwyer/photon-node", "@mariozechner/clipboard", "@mariozechner/clipboard-*"],
	plugins: [bundledEntryPlugin],
	minifyWhitespace: true,
	minifySyntax: true,
	keepNames: true,
	// Bundled CJS dependencies keep some require() calls that esbuild cannot
	// rewrite to imports (e.g. cross-spawn requiring node builtins); provide a
	// real require for the ESM output so the __require shim resolves them.
	banner: {
		js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
	},
	logLevel: "silent",
});

for (const warning of result.warnings) {
	console.warn(`esbuild warning: ${warning.text} (${warning.location?.file}:${warning.location?.line})`);
}

const outputs = ["dist/cli.js", "dist/rpc-entry.js", "dist/image-resize-worker.js"];
for (const output of outputs) {
	const size = statSync(path.join(rootDir, output)).size;
	console.log(`${output}: ${(size / 1024 / 1024).toFixed(2)} MB`);
}
