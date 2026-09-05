import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Context, Model, ProviderHeaders, ProviderResponse } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";

/** Non-secret installation identity. Never read Codex credentials or invent an account/attestation. */
export async function loadRouterInstallationId(): Promise<string> {
	const directory = getAgentDir();
	const path = join(directory, "router-client.json");
	return withFileMutationQueue(path, async () => {
		await mkdir(directory, { recursive: true });
		let compromised: Error | undefined;
		const assertLock = () => {
			if (compromised) throw compromised;
		};
		// A dedicated identity lock also covers the missing-file case. Never read before acquiring it:
		// another process may still be publishing the identity. Bound contention to about five seconds.
		const release = await lockfile.lock(path, {
			realpath: false,
			stale: 30_000,
			retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false },
			onCompromised: (error) => {
				compromised = error;
			},
		});
		let temporary: string | undefined;
		try {
			assertLock();
			let current: string | undefined;
			try {
				current = await readFile(path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			assertLock();
			if (current !== undefined) {
				const value: unknown = JSON.parse(current);
				if (
					!value ||
					typeof value !== "object" ||
					!("installationId" in value) ||
					typeof value.installationId !== "string" ||
					value.installationId.length !== 36 ||
					!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.installationId)
				)
					throw new Error("router-client.json has an invalid installation identity.");
				return value.installationId;
			}
			const installationId = randomUUID();
			temporary = join(directory, `.router-client.${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, `${JSON.stringify({ version: 1, installationId }, null, 2)}\n`, {
					encoding: "utf8",
					mode: 0o600,
					flag: "wx",
				});
			} catch (error) {
				// Do not remove a pre-existing file in the extremely unlikely event of a UUID collision.
				if ((error as NodeJS.ErrnoException).code === "EEXIST") temporary = undefined;
				throw error;
			}
			assertLock();
			await rename(temporary, path);
			assertLock();
			return installationId;
		} finally {
			try {
				if (temporary) await rm(temporary, { force: true });
			} finally {
				await release().catch((error: unknown) => {
					// A compromised lock is already released by proper-lockfile; retain the original error.
					if (!compromised) throw error;
				});
			}
		}
	});
}

interface RequestScope {
	turnId: string;
	startedAt: number;
	turnState?: string;
}

export interface CodexRequestSnapshot {
	headers: ProviderHeaders;
	clientMetadata: Record<string, string>;
	promptCacheKey: string;
	acceptResponse(response: ProviderResponse): void;
}

/** Per-extension-host state. A tool continuation is not a new Codex user turn. */
export class RouterRequestState {
	private readonly windowId = randomUUID();
	private readonly scopes = new Map<string, RequestScope>();

	private readonly installationId: string;

	constructor(installationId: string = randomUUID()) {
		this.installationId = installationId;
	}

	/** Called on user-task start, navigation, model changes and shutdown, not each Pi tool-loop turn. */
	reset(): void {
		this.scopes.clear();
	}

	request(model: Model<Api>, context: Context, suppliedSessionId?: string): CodexRequestSnapshot {
		// Cache keys are limited to 64 characters; HTTP headers also trim surrounding spaces.
		const sessionId =
			suppliedSessionId &&
			suppliedSessionId.length <= 64 &&
			suppliedSessionId.trim() === suppliedSessionId &&
			!/[^\x20-\x7e]/.test(suppliedSessionId)
				? suppliedSessionId
				: suppliedSessionId
					? createHash("sha256").update(suppliedSessionId).digest("hex")
					: randomUUID();
		// Pi sessions are conversation branches; use their identity as both root session and thread.
		// Nested callers should pass their own sessionId. No shared mutable global provider state.
		const threadId = sessionId;
		let userKey = "empty";
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index];
			if (message.role === "user") {
				userKey = createHash("sha256")
					.update(JSON.stringify([index, message]))
					.digest("hex");
				break;
			}
		}
		const key = JSON.stringify([sessionId, model.provider, model.baseUrl, model.id, userKey]);
		let scope = this.scopes.get(key);
		if (!scope) {
			if (this.scopes.size >= 128) this.scopes.delete(this.scopes.keys().next().value!);
			scope = { turnId: randomUUID(), startedAt: Date.now() };
			this.scopes.set(key, scope);
		}
		const turnMetadata = JSON.stringify({
			installation_id: this.installationId,
			session_id: sessionId,
			thread_id: threadId,
			turn_id: scope.turnId,
			window_id: this.windowId,
			request_kind: "turn",
			turn_started_at_unix_ms: scope.startedAt,
		});
		const headers: ProviderHeaders = {
			"session-id": sessionId,
			"thread-id": threadId,
			"x-client-request-id": threadId,
			"x-codex-window-id": this.windowId,
			"x-codex-turn-metadata": turnMetadata,
		};
		if (scope.turnState) headers["x-codex-turn-state"] = scope.turnState;
		const activeScope = scope;
		return {
			headers,
			promptCacheKey: sessionId,
			clientMetadata: {
				"x-codex-installation-id": this.installationId,
				session_id: sessionId,
				thread_id: threadId,
				turn_id: scope.turnId,
				"x-codex-window-id": this.windowId,
				"x-codex-turn-metadata": turnMetadata,
			},
			acceptResponse: (response) => {
				if (response.status < 200 || response.status >= 300 || activeScope.turnState !== undefined) return;
				const token = Object.entries(response.headers).find(
					([name]) => name.toLowerCase() === "x-codex-turn-state",
				)?.[1];
				// Response headers are untrusted and tokens must stay bounded, opaque, and turn-local.
				if (token && token.length <= 8192 && /^[\x20-\x7e]+$/.test(token)) activeScope.turnState = token;
			},
		};
	}
}
