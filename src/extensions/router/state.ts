import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Context, Model, ProviderHeaders, ProviderResponse } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { withFileMutationQueue } from "../../core/tools/file-mutation-queue.ts";

/** Non-secret installation identity. Never read Codex credentials or invent an account/attestation. */
export async function loadRouterInstallationId(): Promise<string> {
	const path = join(getAgentDir(), "router-client.json");
	return withFileMutationQueue(path, async () => {
		try {
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				value &&
				typeof value === "object" &&
				"installationId" in value &&
				typeof value.installationId === "string" &&
				/^[0-9a-f-]{36}$/i.test(value.installationId)
			) {
				return value.installationId;
			}
			throw new Error("router-client.json has an invalid installation identity.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(getAgentDir(), { recursive: true });
		const installationId = randomUUID();
		try {
			await writeFile(path, `${JSON.stringify({ version: 1, installationId }, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
		} catch (error) {
			// A second process may have created the identity after our read; do not overwrite it.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const value: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				!("installationId" in value) ||
				typeof value.installationId !== "string" ||
				!/^[0-9a-f-]{36}$/i.test(value.installationId)
			) {
				throw new Error("router-client.json has an invalid installation identity.");
			}
			return value.installationId;
		}
		return installationId;
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
		const sessionId =
			suppliedSessionId && /^[\x20-\x7e]{1,256}$/.test(suppliedSessionId)
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
