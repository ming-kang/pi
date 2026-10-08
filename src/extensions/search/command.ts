/** `/search` and the tool activation that follows the account state. */
import { homedir } from "node:os";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import {
	createSignIn,
	credentialPath,
	deleteCredential,
	ENV_KEY,
	exchangeCode,
	getCredential,
	looksLikeToken,
	saveCredential,
	toApiKey,
} from "./credential.ts";
import { webSearch } from "./devin.ts";
import { type PanelActions, SearchPanel } from "./panel.ts";

/** `~/.pi/agent/search-auth.json` rather than the full home path, so panel rows stay short. */
function displayPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length).replace(/\\/g, "/")}` : path;
}

const TOOL_NAMES = ["code_search", "web_search"];

/** Deactivate both tools when no credential exists; `activate` re-enables them after a sign-in. */
export function syncTools(pi: ExtensionAPI, activate = false): void {
	const active = pi.getActiveTools();
	if (!getCredential()) {
		const next = active.filter((name) => !TOOL_NAMES.includes(name));
		if (next.length !== active.length) pi.setActiveTools(next);
	} else if (activate) {
		const missing = TOOL_NAMES.filter((name) => !active.includes(name));
		if (missing.length) pi.setActiveTools([...active, ...missing]);
	}
}

function accountActions(pi: ExtensionAPI): PanelActions {
	/** One cheap authenticated call, so a bad token fails here rather than at the model's first search. */
	const verifyAndSave = async (token: string) => {
		await webSearch(toApiKey(token), "Devin", 1);
		saveCredential(token);
		syncTools(pi, true);
	};
	return {
		state() {
			const source = getCredential()?.source;
			return { source, location: source === "env" ? ENV_KEY : displayPath(credentialPath()) };
		},
		startSignIn() {
			const attempt = createSignIn();
			openBrowser(attempt.url);
			return {
				url: attempt.url,
				complete: async (input) =>
					verifyAndSave(looksLikeToken(input) ? input : await exchangeCode(attempt, input)),
			};
		},
		saveToken: verifyAndSave,
		signOut() {
			deleteCredential();
			syncTools(pi);
		},
	};
}

export function registerSearchCommand(pi: ExtensionAPI): void {
	pi.registerCommand("search", {
		description: "Sign in to Devin for code_search and web_search",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const credential = getCredential();
				ctx.ui.notify(
					credential
						? `Devin Search: signed in ($credential.source === "env" ? ENV_KEY : credentialPath()).`
						: `Devin Search: not signed in. Run /search interactively, or set $ENV_KEY.`,
					credential ? "info" : "warning",
				);
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) =>
					new SearchPanel(tui, theme, keybindings, accountActions(pi), () => done()),
			);
		},
	});
}
