import { getKeybindings } from "@earendil-works/pi-tui";
import type { EditorSubmitEvent, ExtensionContext } from "../../core/extensions/index.ts";
import { BtwAgent } from "./agent.ts";
import { BTW_WIDGET } from "./constants.ts";
import { BtwPanel, type BtwPanelState } from "./panel.ts";

interface Conversation {
	ctx: ExtensionContext;
	state: BtwPanelState;
	panel?: BtwPanel;
	agent?: BtwAgent;
	unsubscribeKeys?: () => void;
}

/** A conversation object's identity guards all callbacks across close/reopen and reload. */
export class BtwController {
	private current?: Conversation;

	async open(question: string, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/btw is available in interactive mode.", "warning");
			return;
		}
		this.close(false);
		ctx.ui.setEditorText("");
		const conversation: Conversation = {
			ctx,
			state: { phase: "opening", busy: false, turns: [], blockedTools: 0 },
		};
		this.current = conversation;
		try {
			// Calling now fixes source state before UI setup or asynchronous preparation.
			const pendingSnapshot = ctx.getContextSnapshot();
			ctx.ui.setWidget(
				BTW_WIDGET,
				(tui) => {
					const panel = new BtwPanel(
						tui,
						() => ctx.ui.theme,
						() => conversation.state,
					);
					conversation.panel = panel;
					return panel;
				},
				{ placement: "aboveEditor" },
			);
			conversation.unsubscribeKeys = ctx.ui.onTerminalInput((data) => this.handleKey(conversation, data), {
				scope: "editor",
			});
			const snapshot = await pendingSnapshot;
			if (this.current !== conversation) return;
			conversation.agent = new BtwAgent(snapshot, ctx.modelRuntime, () => this.refresh(conversation));
			conversation.state = {
				phase: "ready",
				capturedAt: snapshot.capturedAt,
				model: `${snapshot.model.provider}/${snapshot.model.id}`,
				busy: false,
				turns: conversation.agent.turns,
				usage: conversation.agent.usage,
				usesSubscription: ctx.modelRegistry.isUsingOAuth(snapshot.model),
				blockedTools: 0,
			};
			this.refresh(conversation);
			if (question.trim()) {
				const result = this.submit(question.trim());
				if (result?.editorText && !ctx.ui.getEditorText()) ctx.ui.setEditorText(result.editorText);
			}
		} catch (error) {
			if (this.current !== conversation) return;
			conversation.state.phase = "error";
			conversation.state.error = error instanceof Error ? error.message : String(error);
			conversation.panel?.changed();
			if (question && !ctx.ui.getEditorText()) ctx.ui.setEditorText(question);
		}
	}

	intercept(event: EditorSubmitEvent, ctx: ExtensionContext): { handled: true; editorText?: string } | undefined {
		const command = /^\/btw(?:\s+([\s\S]*))?$/.exec(event.text);
		if (command) {
			void this.open(command[1] ?? "", ctx);
			return { handled: true };
		}
		if (!this.current || event.kind !== "prompt") return undefined;
		return this.submit(event.text);
	}

	close(clearEditor = true): void {
		const conversation = this.current;
		if (!conversation) return;
		this.current = undefined;
		conversation.unsubscribeKeys?.();
		conversation.panel?.dispose();
		conversation.agent?.dispose();
		conversation.ctx.ui.setWidget(BTW_WIDGET, undefined);
		if (clearEditor) conversation.ctx.ui.setEditorText("");
	}

	private submit(text: string): { handled: true; editorText?: string } | undefined {
		const conversation = this.current;
		if (!conversation) return undefined;
		const error =
			conversation.agent?.validate(text) ??
			(conversation.agent ? undefined : "BTW is not ready. Reopen /btw if context preparation failed.");
		if (error) {
			conversation.ctx.ui.notify(error, "warning");
			return { handled: true, editorText: text };
		}
		conversation.panel?.followTail();
		void conversation.agent!.ask(text).catch((error: unknown) => {
			if (this.current !== conversation) return;
			conversation.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			if (!conversation.ctx.ui.getEditorText()) conversation.ctx.ui.setEditorText(text);
		});
		return { handled: true };
	}

	private refresh(conversation: Conversation): void {
		if (this.current !== conversation) return;
		conversation.state.busy = conversation.agent?.busy ?? false;
		conversation.state.blockedTools = conversation.agent?.blockedTools ?? 0;
		conversation.state.latestCacheHitPercent = conversation.agent?.latestCacheHitPercent;
		conversation.panel?.changed();
	}

	private handleKey(conversation: Conversation, data: string): { consume: true } | undefined {
		if (this.current !== conversation) return undefined;
		const keys = getKeybindings();
		if (keys.matches(data, "app.btw.close")) {
			this.close();
			return { consume: true };
		}
		if (keys.matches(data, "app.btw.cancel")) {
			if (conversation.agent?.busy) conversation.agent.cancel();
			else this.close();
			return { consume: true };
		}
		// Main prompt history never belongs in this editor mode, including explicit
		// history bindings. Autocomplete/dialog input is excluded by the host scope.
		if (keys.matches(data, "tui.editor.historyPrevious") || keys.matches(data, "tui.editor.historyNext")) {
			return { consume: true };
		}
		const direction = keys.matches(data, "app.btw.scrollUp") ? -1 : keys.matches(data, "app.btw.scrollDown") ? 1 : 0;
		const cursorUp = keys.matches(data, "tui.editor.cursorUp");
		const cursorDown = keys.matches(data, "tui.editor.cursorDown");
		if (!conversation.ctx.ui.getEditorText()) {
			if (direction) conversation.panel?.scroll(direction);
			if (direction || cursorUp || cursorDown) return { consume: true };
		} else if (cursorUp || cursorDown) {
			const cursor = conversation.ctx.ui.getEditorCursor();
			// The native editor browses history on Up at the start of the draft.
			// Let it keep normal movement within multiline and wrapped drafts.
			if (!cursor || (cursorUp && cursor.line === 0 && cursor.col === 0)) return { consume: true };
		}
		return undefined;
	}
}
