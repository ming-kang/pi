// Copied to the temporary installation root by verify-package-install.mjs.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DefaultResourceLoader, resizeImage } from "./node_modules/@astralyn/pi/dist/bundle/index.js";

const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: process.env.PI_CODING_AGENT_DIR,
	additionalExtensionPaths: [fileURLToPath(new URL("./package-bundle-extension.ts", import.meta.url))],
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

console.log("Verified bundled extension reload, OAuth flows, Bedrock loading, and image worker.");
