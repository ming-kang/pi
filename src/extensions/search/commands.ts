import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { CMD_KEY, CMD_LOGIN, CMD_LOGOUT, CMD_STATUS, ENV_KEY, EXTENSION_LABEL } from "./constants.ts";
import { looksTruncated, TRUNCATED_KEY_HINT } from "./key-format.ts";
import { clearApiKey, getKeyInfo, maskKey, setApiKey } from "./keystore.ts";
import { createAuthorizeUrl, exchangeCode, OAuthError, tokenExpiresAt, validateCode } from "./oauth.ts";
import { reconcileSearchTools } from "./reconcile.ts";
import { keyFilePath } from "./storage.ts";

function describeKey(): string {
	const info = getKeyInfo();
	if (!info) return "no key configured";
	const source = info.source === "env" ? `from ${ENV_KEY}` : `saved (${info.source})`;
	const exp = tokenExpiresAt(info.key);
	const expiry = exp ? `, JWT exp ${new Date(exp).toISOString()}` : "";
	return `${maskKey(info.key)} — ${source}${expiry}`;
}

function noKeyHint(): string {
	return `${EXTENSION_LABEL}: no key. Run /${CMD_KEY} to paste one, /${CMD_LOGIN} to authorize in the browser, or set ${ENV_KEY}.`;
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand(CMD_KEY, {
		description: `Set or clear the Devin key for ${EXTENSION_LABEL}`,
		handler: async (_args, ctx) => {
			const configured = !!getKeyInfo();
			if (!ctx.hasUI) {
				ctx.ui.notify(
					configured ? `${EXTENSION_LABEL}: key ${describeKey()} (${keyFilePath()}).` : noKeyHint(),
					configured ? "info" : "warning",
				);
				return;
			}
			// ctx.ui.input renders only the title, so status + instructions live there.
			const title = configured
				? `${EXTENSION_LABEL} — key ${describeKey()}. Paste a new key, or submit empty to clear.`
				: `${EXTENSION_LABEL} — no key. Paste your Devin token (devin-session-token$<JWT>).`;
			const value = await ctx.ui.input(title);
			if (value === undefined) return; // Esc: cancelled

			const trimmed = value.trim();
			if (!trimmed) {
				if (configured) {
					clearApiKey();
					reconcileSearchTools(pi);
					ctx.ui.notify(`${EXTENSION_LABEL} key cleared — tools disabled (removed ${keyFilePath()}).`, "info");
				} else {
					ctx.ui.notify(`${EXTENSION_LABEL}: no key entered.`, "info");
				}
				return;
			}
			setApiKey(trimmed, "manual");
			reconcileSearchTools(pi);
			if (looksTruncated(trimmed)) {
				ctx.ui.notify(`${EXTENSION_LABEL}: ${TRUNCATED_KEY_HINT}`, "warning");
			}
			ctx.ui.notify(`${EXTENSION_LABEL} key saved — tools enabled → ${keyFilePath()}`, "info");
		},
	});

	pi.registerCommand(CMD_LOGIN, {
		description: `Authorize ${EXTENSION_LABEL} with Devin OAuth (browser + one-time code)`,
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`${EXTENSION_LABEL}: OAuth login needs an interactive Pi session. Set ${ENV_KEY} instead.`,
					"error",
				);
				return;
			}
			const attempt = createAuthorizeUrl();
			ctx.ui.notify(`Open this URL to authorize: ${attempt.url}`, "info");
			const value = await ctx.ui.input(
				`${EXTENSION_LABEL} — open ${attempt.url} in your browser, then paste the one-time code below.`,
			);
			if (value === undefined) {
				ctx.ui.notify(`${EXTENSION_LABEL}: login cancelled.`, "info");
				return;
			}
			let token: string;
			try {
				token = await exchangeCode(attempt, validateCode(value));
			} catch (e) {
				ctx.ui.notify(
					`${EXTENSION_LABEL}: ${e instanceof OAuthError || e instanceof Error ? e.message : "login failed"}`,
					"error",
				);
				return;
			}
			setApiKey(token, "oauth");
			reconcileSearchTools(pi);
			const exp = tokenExpiresAt(token);
			ctx.ui.notify(
				`${EXTENSION_LABEL} login successful — tools enabled${exp ? ` (JWT exp ${new Date(exp).toISOString()})` : " (session has no expiry)"}. Key saved to ${keyFilePath()}.`,
				"info",
			);
		},
	});

	pi.registerCommand(CMD_STATUS, {
		description: `Show ${EXTENSION_LABEL} key state`,
		handler: async (_args, ctx) => {
			const configured = !!getKeyInfo();
			ctx.ui.notify(
				configured ? `${EXTENSION_LABEL}: ${describeKey()}` : noKeyHint(),
				configured ? "info" : "warning",
			);
		},
	});

	pi.registerCommand(CMD_LOGOUT, {
		description: `Clear the stored ${EXTENSION_LABEL} key`,
		handler: async (_args, ctx) => {
			const configured = !!getKeyInfo();
			if (configured) {
				clearApiKey();
				reconcileSearchTools(pi);
				ctx.ui.notify(`${EXTENSION_LABEL} logged out — tools disabled (removed ${keyFilePath()}).`, "info");
			} else {
				ctx.ui.notify(`${EXTENSION_LABEL}: no key to clear.`, "info");
			}
		},
	});
}
