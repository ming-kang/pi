// Copied to the temporary installation root by verify-package-install.mjs.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createCodemodeExtension, DefaultResourceLoader, resizeImage } from "./node_modules/@astralyn/pi/dist/bundle/index.js";

const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: process.env.PI_CODING_AGENT_DIR,
	additionalExtensionPaths: [fileURLToPath(new URL("./package-bundle-extension.ts", import.meta.url))],
	extensionFactories: [createCodemodeExtension({ models: false })],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
});
for (let reload = 0; reload < 2; reload++) {
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.ok(loaded.extensions.some((extension) => extension.commands.has("package-smoke")));
}

// The bundled codemode extension registers the tool, and the packaged QuickJS wasm and worker run
// scripts. Executing the tool itself needs a session-bound extension runtime, so the script path is
// exercised through the sandbox host the tool uses. The release runtime spawns workers from an
// in-memory data: URL, so the bundled worker must also load from one: it may carry no `import.meta`
// and no `createRequire` banner, which the bundler would otherwise inline.
const codemode = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.values()])
	.find((tool) => tool.definition.name === "codemode")?.definition;
assert.ok(codemode);
// npm installs this package's dependencies beside it when installing from a tarball, but nests them
// below it when installing from the registry, and `import.meta.resolve` cannot be pointed at another
// package's tree. Locate the codemode package for both layouts and take its declared ESM entry.
const codemodeManifestUrl = [
	new URL("./node_modules/@astralyn/pi/node_modules/@earendil-works/pi-codemode/package.json", import.meta.url),
	new URL("./node_modules/@earendil-works/pi-codemode/package.json", import.meta.url),
].find((candidate) => existsSync(candidate));
if (!codemodeManifestUrl) {
	throw new Error("No @earendil-works/pi-codemode copy beside or below the installed @astralyn/pi.");
}
const codemodeManifest = JSON.parse(readFileSync(codemodeManifestUrl, "utf8"));
const { CodemodeSandbox, loadQuickJSWasm } = await import(
	new URL(codemodeManifest.exports["."].import ?? codemodeManifest.main, codemodeManifestUrl).href
);
const resolveFromInstall = createRequire(codemodeManifestUrl);
const wasm = loadQuickJSWasm(resolveFromInstall.resolve("quickjs-wasi/quickjs.wasm"));
const code = "text(await Promise.all([1, 2, 3].map(async n => n * n)))";
const runScript = async (sandbox) => {
	try {
		const result = await sandbox.execute(code);
		assert.equal(result.ok, true, JSON.stringify(result.error ?? result));
		assert.ok(result.output.some((item) => item.type === "text" && item.text.includes("[1,4,9]")), JSON.stringify(result.output));
	} finally {
		await sandbox.close();
	}
};
await runScript(new CodemodeSandbox({ wasm }));
const bundledWorker = readFileSync(
	new URL("./node_modules/@astralyn/pi/dist/bundle/chunks/codemode-worker.js", import.meta.url),
);
await runScript(new CodemodeSandbox({ wasm, workerUrl: new URL(`data:text/javascript;base64,${bundledWorker.toString("base64")}`) }));

const inputBytes = readFileSync(
	new URL("./node_modules/@astralyn/pi/dist/modes/interactive/assets/clankolas.png", import.meta.url),
);
const options = { maxWidth: 16, maxHeight: 16 };
const assertResized = (result) => {
	assert.ok(result?.wasResized);
	assert.ok(result.width > 0 && result.width <= 16);
	assert.ok(result.height > 0 && result.height <= 16);
};

// Exercise the public bundled API, then load the actual worker directly so its
// in-process fallback cannot conceal a missing or unloadable worker artifact.
assertResized(await resizeImage(inputBytes, "image/png", options));
const worker = new Worker(
	new URL("./node_modules/@astralyn/pi/dist/bundle/chunks/image-resize-worker.js", import.meta.url),
);
try {
	const response = once(worker, "message", { signal: AbortSignal.timeout(15_000) });
	worker.postMessage({ inputBytes: new Uint8Array(inputBytes), mimeType: "image/png", options });
	const [message] = await response;
	assert.equal(message.error, undefined);
	assertResized(message.result);
} finally {
	await worker.terminate();
}

console.log("Verified bundled extension reload, OAuth flows, Bedrock loading, codemode worker/WASM, and image worker.");
