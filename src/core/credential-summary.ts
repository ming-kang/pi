import type { Credential } from "@earendil-works/pi-ai";

/** What a settings UI may show about a credential: never the secret, only enough to recognize it. */
export type CredentialSummary =
	| {
			type: "api_key";
			/** Last four characters, for keys long enough that four reveal nothing useful. */
			keyHint?: string;
	  }
	| { type: "oauth"; expires?: number; account?: string };

const KEY_HINT_MIN_LENGTH = 16;
const OAUTH_ACCOUNT_FIELDS = ["email", "account", "accountId"] as const;

export function summarizeCredential(credential: Credential): CredentialSummary {
	if (credential.type === "api_key") {
		const key = credential.key ?? "";
		return key.length >= KEY_HINT_MIN_LENGTH ? { type: "api_key", keyHint: key.slice(-4) } : { type: "api_key" };
	}
	const fields = credential as Record<string, unknown>;
	const account = OAUTH_ACCOUNT_FIELDS.map((field) => fields[field]).find(
		(value): value is string => typeof value === "string" && value !== "",
	);
	const expires = typeof credential.expires === "number" ? credential.expires : undefined;
	return { type: "oauth", ...(expires !== undefined ? { expires } : {}), ...(account ? { account } : {}) };
}
