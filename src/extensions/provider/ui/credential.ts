/**
 * The Credential row of a built-in provider's Authentication page: what
 * /login stored (masked), replacing the key in place, and logging out.
 * Secrets never reach the panel; it reads ModelRuntime.describeCredential().
 */

import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { CredentialSummary } from "../../../core/credential-summary.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { formatError, isApiKeyReference } from "../constants.ts";

export type CredentialRuntime = Pick<
	ModelRuntime,
	"getProviderAuthStatus" | "isUsingOAuth" | "describeCredential" | "login" | "logout"
>;

const MASK = "••••";

/**
 * One-phrase credential source for the provider list, e.g. "API key", "OAuth",
 * "env DEEPSEEK_API_KEY"; CredentialState.describe() is the page's longer form.
 */
export function credentialSource(
	runtime: Pick<CredentialRuntime, "getProviderAuthStatus" | "isUsingOAuth">,
	providerId: string,
): string | undefined {
	const status = runtime.getProviderAuthStatus(providerId);
	if (!status.configured) return undefined;
	switch (status.source) {
		case "stored":
			return runtime.isUsingOAuth(providerId) ? "OAuth" : "API key";
		case "runtime":
			return "session key";
		case "environment":
			return status.label ? `env ${status.label}` : "env";
		case "models_json_key":
		case "models_json_command":
			return "models.json key";
		default:
			return undefined;
	}
}

function expiryText(expires: number): string {
	if (expires <= Date.now()) return "expired, refreshes on next use";
	const date = new Date(expires);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `expires ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function keyText(summary: CredentialSummary | undefined): string {
	return summary?.type === "api_key" && summary.keyHint ? `API key ${MASK}${summary.keyHint}` : "API key";
}

/** Live view of one provider's credential; `onChange` re-renders after async reads and writes. */
export class CredentialState {
	private readonly runtime: CredentialRuntime;
	private readonly providerId: string;
	private onChange: () => void;
	private summary: CredentialSummary | undefined;
	/** In-flight action label, e.g. "Saving key…". */
	busy: string | undefined;
	/** Outcome of the last action, shown under the rows until the next one. */
	result: { text: string; error: boolean } | undefined;

	constructor(runtime: CredentialRuntime, providerId: string, onChange: () => void) {
		this.runtime = runtime;
		this.providerId = providerId;
		this.onChange = onChange;
		this.reload();
	}

	/** The page closed: late async results no longer re-render it. */
	dispose(): void {
		this.onChange = () => {};
	}

	private reload(): void {
		this.runtime.describeCredential(this.providerId).then(
			(summary) => {
				this.summary = summary;
				this.onChange();
			},
			() => {},
		);
	}

	/** True when /login stored the credential, so Log out has something to remove. */
	get stored(): boolean {
		const status = this.runtime.getProviderAuthStatus(this.providerId);
		return status.configured && status.source === "stored";
	}

	get oauth(): boolean {
		return this.stored && this.runtime.isUsingOAuth(this.providerId);
	}

	/** The Credential row value; `unset` renders it dim. */
	describe(): { text: string; unset: boolean } {
		const status = this.runtime.getProviderAuthStatus(this.providerId);
		if (!status.configured) return { text: "not set", unset: true };
		switch (status.source) {
			case "stored": {
				if (!this.oauth) return { text: `${keyText(this.summary)} · saved by /login`, unset: false };
				const summary = this.summary?.type === "oauth" ? this.summary : undefined;
				// An account or expiry already says the login exists; "logged in" only fills the gap.
				const parts = ["OAuth"];
				if (summary?.account) parts.push(summary.account);
				if (summary?.expires !== undefined) parts.push(expiryText(summary.expires));
				if (parts.length === 1) parts.push("logged in");
				return { text: parts.join(" · "), unset: false };
			}
			case "runtime":
				return { text: `${keyText(this.summary)} · this session only (--api-key)`, unset: false };
			case "environment":
				return { text: `from env ${status.label ?? "variable"}`, unset: false };
			case "models_json_key":
			case "models_json_command":
				return { text: "apiKey in models.json (below)", unset: false };
			default:
				return { text: "not set", unset: true };
		}
	}

	/** Checks a typed key before saving; returns why it cannot be saved. */
	validateKey(raw: string): string | undefined {
		const key = raw.trim();
		if (!key) return "Type or paste the key; Esc keeps the current credential.";
		if (isApiKeyReference(key)) return "Enter the key itself; $VAR and !command references belong in models.json.";
		return undefined;
	}

	/** Save the key the way /login does: the provider's API-key login answered with it. */
	replaceKey(key: string): void {
		let answered = false;
		const interaction: AuthInteraction = {
			prompt: async (prompt) => {
				if (prompt.type === "secret" && !answered) {
					answered = true;
					return key;
				}
				throw new Error(`${this.providerId} needs more than a key here; use /login ${this.providerId}.`);
			},
			notify: () => {},
		};
		this.run("Saving key…", "Key saved to auth.json.", () =>
			this.runtime.login(this.providerId, "api_key", interaction).then(() => {}),
		);
	}

	logout(): void {
		this.run("Logging out…", "Logged out.", () => this.runtime.logout(this.providerId));
	}

	private run(busy: string, done: string, action: () => Promise<void>): void {
		this.busy = busy;
		this.result = undefined;
		this.onChange();
		action()
			.then(
				() => {
					this.result = { text: done, error: false };
				},
				(error: unknown) => {
					this.result = { text: formatError(error), error: true };
				},
			)
			.finally(() => {
				this.busy = undefined;
				this.reload();
				this.onChange();
			});
	}
}
