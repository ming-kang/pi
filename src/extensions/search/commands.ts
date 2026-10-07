/**
 * The `/search` menu: one entry point for signing in, pasting a key, and clearing the saved key.
 * `ctx.ui.select` resolves to the chosen label, so the labels are also the actions.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CMD_SEARCH, ENV_KEY, EXTENSION_LABEL } from "./constants.ts";
import { looksTruncated, TRUNCATED_KEY_HINT } from "./key-format.ts";
import { clearApiKey, getKeyInfo, maskKey, setApiKey } from "./keystore.ts";
import { createAuthorizeUrl, exchangeCode, OAuthError, tokenExpiresAt, validateCode } from "./oauth.ts";
import { reconcileSearchTools } from "./reconcile.ts";
import { keyFilePath } from "./storage.ts";

const SIGN_IN_ACCOUNT = "Sign in with Devin account";
const SIGN_IN_KEY = "Sign in with Devin key";
const CLEAR_KEY = "Clear saved key";

/** Whether this extension owns a key file it can delete; a key from the environment is not ours to remove. */
function hasSavedKey(): boolean {
	const info = getKeyInfo();
	return !!info && info.source !== "env";
}

/**
 * The menu heading. The rows already carry the state, since `Clear saved key` exists only while a
 * key is saved, so the heading speaks up for the one state no row can resolve: an environment key.
 */
function menuTitle(): string {
	return getKeyInfo()?.source === "env"
		? `${EXTENSION_LABEL}\nThe key comes from ${ENV_KEY}; unset it to remove it.`
		: EXTENSION_LABEL;
}

/** The one-line key state, for the modes that get a notification instead of a menu. */
function statusDetail(): string {
	const info = getKeyInfo();
	if (!info) return "";
	const origin =
		info.source === "env"
			? `from ${ENV_KEY}`
			: info.source === "oauth"
				? "saved by account login"
				: "saved from a pasted key";
	const exp = tokenExpiresAt(info.key);
	return `${maskKey(info.key)} — ${origin}${exp ? `, expires ${new Date(exp).toISOString()}` : ""}`;
}

/** Shown when no dialog-capable UI is available. */
function noKeyHint(): string {
	return `${EXTENSION_LABEL}: no key. Run /${CMD_SEARCH} in an interactive session to sign in, or set ${ENV_KEY}.`;
}

async function signInWithAccount(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const attempt = createAuthorizeUrl();
	openBrowser(attempt.url);
	// The URL belongs in this dialog's title rather than a separate notification: a notification
	// here would append a status line to the transcript between the menu closing and this dialog
	// opening, and the chat area jumping by a line right then reads as a flicker.
	const value = await ctx.ui.input(
		`${EXTENSION_LABEL} — authorize in your browser, then paste the one-time code below.\nIf it did not open: ${attempt.url}`,
	);
	if (value === undefined) {
		ctx.ui.notify(`${EXTENSION_LABEL}: sign-in cancelled.`, "info");
		return;
	}
	let token: string;
	try {
		token = await exchangeCode(attempt, validateCode(value));
	} catch (e) {
		const message = e instanceof OAuthError || e instanceof Error ? e.message : "sign-in failed";
		ctx.ui.notify(`${EXTENSION_LABEL}: ${message}`, "error");
		return;
	}
	setApiKey(token, "oauth");
	reconcileSearchTools(pi);
	const exp = tokenExpiresAt(token);
	ctx.ui.notify(
		`${EXTENSION_LABEL} signed in — tools enabled${exp ? ` (token expires ${new Date(exp).toISOString()})` : ""}. Saved to ${keyFilePath()}.`,
		"info",
	);
}

async function signInWithKey(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const value = await ctx.ui.input(`${EXTENSION_LABEL} — paste your Devin key.`);
	if (value === undefined) return; // Esc: cancelled, and an empty dialog is not worth reporting
	const key = value.trim();
	if (!key) {
		ctx.ui.notify(`${EXTENSION_LABEL}: no key entered — nothing changed.`, "info");
		return;
	}
	setApiKey(key, "manual");
	reconcileSearchTools(pi);
	if (looksTruncated(key)) ctx.ui.notify(`${EXTENSION_LABEL}: ${TRUNCATED_KEY_HINT}`, "warning");
	ctx.ui.notify(`${EXTENSION_LABEL} key saved — tools enabled → ${keyFilePath()}`, "info");
}

async function clearSavedKey(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		`Clear the saved ${EXTENSION_LABEL} key?`,
		`This deletes ${keyFilePath()} and disables code_search and web_search until you sign in again.`,
	);
	if (!confirmed) return;
	clearApiKey();
	reconcileSearchTools(pi);
	ctx.ui.notify(`${EXTENSION_LABEL} signed out — tools disabled (removed ${keyFilePath()}).`, "info");
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand(CMD_SEARCH, {
		description: `Sign in to ${EXTENSION_LABEL}, or clear the saved key`,
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				const detail = statusDetail();
				ctx.ui.notify(detail ? `${EXTENSION_LABEL}: ${detail}` : noKeyHint(), detail ? "info" : "warning");
				return;
			}
			const options = [SIGN_IN_ACCOUNT, SIGN_IN_KEY, ...(hasSavedKey() ? [CLEAR_KEY] : [])];
			const choice = await ctx.ui.select(menuTitle(), options);
			switch (choice) {
				case SIGN_IN_ACCOUNT:
					await signInWithAccount(pi, ctx);
					break;
				case SIGN_IN_KEY:
					await signInWithKey(pi, ctx);
					break;
				case CLEAR_KEY:
					await clearSavedKey(pi, ctx);
					break;
			}
		},
	});
}
