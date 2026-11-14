#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

function duration(ms) {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Wait until npm serves both the exact version and its latest dist-tag. */
export async function waitForNpmRelease({
	name,
	version,
	registryUrl = DEFAULT_REGISTRY,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	intervalMs = DEFAULT_INTERVAL_MS,
	requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	fetchImpl = fetch,
	now = Date.now,
	sleepImpl = sleep,
	log = console.log,
}) {
	if (!name || !version) throw new Error("Both package name and version are required.");
	const target = `${name}@${version}`;
	const url = `${registryUrl.replace(/\/+$/, "")}/${name.replace("/", "%2f")}`;
	const started = now();
	let attempts = 0;
	log(`Waiting for ${target} to become live on npm...`);

	while (true) {
		attempts++;
		let pending;
		let response;
		try {
			response = await fetchImpl(url, {
				cache: "no-store",
				headers: { accept: "application/vnd.npm.install-v1+json", "cache-control": "no-cache" },
				signal: AbortSignal.timeout(requestTimeoutMs),
			});
		} catch (error) {
			pending = `request failed: ${errorText(error)}`;
		}

		if (response) {
			if (!response.ok) {
				if (response.status !== 404 && response.status !== 429 && response.status < 500) {
					throw new Error(`npm returned HTTP ${response.status} for ${target}; not retrying.`);
				}
				pending = `registry returned HTTP ${response.status}`;
			} else {
				pending = "registry returned an empty response";
				let metadata;
				try {
					metadata = await response.json();
				} catch (error) {
					pending = `invalid registry response: ${errorText(error)}`;
				}
				if (metadata) {
					const hasVersion = Boolean(metadata.versions?.[version]);
					const latest = metadata["dist-tags"]?.latest;
					if (hasVersion && latest === version) {
						const elapsedMs = now() - started;
						log(`${target} is live and latest after ${duration(elapsedMs)}.`);
						return { attempts, elapsedMs };
					}
					pending = hasVersion ? `latest is ${latest ?? "missing"}` : "version is not visible";
				}
			}
		}

		const elapsedMs = now() - started;
		if (elapsedMs >= timeoutMs) {
			throw new Error(
				`Timed out after ${duration(timeoutMs)} waiting for ${target}. npm may already have accepted it; ` +
					"retry this wait or the CI tag job, not npm publish.",
			);
		}
		log(`Still waiting for ${target}: ${pending} (${duration(elapsedMs)})`);
		await sleepImpl(Math.min(intervalMs, timeoutMs - elapsedMs));
	}
}

async function main(args) {
	if (args.length > 1) throw new Error("Usage: npm run release:wait -- [version]");
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	await waitForNpmRelease({ name: manifest.name, version: args[0] ?? manifest.version });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(errorText(error));
		process.exitCode = 1;
	});
}
