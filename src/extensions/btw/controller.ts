import "./keybindings.ts";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { EditorSubmitEvent, ExtensionContext } from "../../core/extensions/index.ts";
import { BtwAgent } from "./agent.ts";
import { BTW_WIDGET } from "./constants.ts";
import { BtwPanel, type BtwPanelState } from "./panel.ts";

interface Conversation {
	ctx: ExtensionContext;
	state: BtwPanelState<BtwAgent>;
	panel?: BtwPanel;
	unsubscribeKeys?: () => void;
}

/** A conversation object's identity guards all callbacks across close/reopen and reload. */
export class BtwController {
	private current?: Conversation;

	async open(question: string, ctx: ExtensionContext): Promise<void> {
		const editorHost = ctx.ui.editorHost;
		if (!editorHost) {
			ctx.ui.notify("/btw is available in interactive mode.", "warning");
			return;
		}
		this.close();
		ctx.ui.setEditorText("");
		const conversation: Conversation = {
			ctx,
			state: { phase: "opening" },
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
			conversation.unsubscribeKeys = editorHost.onInput((data) => this.handleKey(conversation, data));
			const snapshot = await pendingSnapshot;
			if (this.current !== conversation) return;
			const usesSubscription = ctx.modelRegistry.isUsingOAuth(snapshot.model);
			conversation.state = {
				phase: "ready",
				capturedAt: snapshot.capturedAt,
				model: `${snapshot.model.provider}/${snapshot.model.id}`,
				usesSubscription,
				conversation: new BtwAgent(snapshot, ctx.modelRuntime, () => {
					if (this.current === conversation) conversation.panel?.changed();
				}),
			};
			conversation.panel?.changed();
			if (question.trim()) {
				const result = this.submit(conversation, question.trim());
				if (result.editorText && !ctx.ui.getEditorText()) ctx.ui.setEditorText(result.editorText);
			}
		} catch (error) {
			if (this.current !== conversation) return;
			if (conversation.state.phase === "ready") conversation.state.conversation.dispose();
			conversation.state = { phase: "error", error: error instanceof Error ? error.message : String(error) };
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
		return this.submit(this.current, event.text);
	}

	close(): void {
		const conversation = this.current;
		if (!conversation) return;
		this.current = undefined;
		conversation.unsubscribeKeys?.();
		conversation.panel?.dispose();
		if (conversation.state.phase === "ready") conversation.state.conversation.dispose();
		conversation.ctx.ui.setWidget(BTW_WIDGET, undefined);
		// The open panel owns the editor draft; never hand it back to the main conversation.
		conversation.ctx.ui.setEditorText("");
	}

	private submit(conversation: Conversation, text: string): { handled: true; editorText?: string } {
		const { state } = conversation;
		const result =
			state.phase === "ready"
				? state.conversation.startQuestion(text)
				: { error: "BTW is not ready. Reopen /btw if context preparation failed." };
		if ("error" in result) {
			conversation.ctx.ui.notify(result.error, "warning");
			return { handled: true, editorText: text };
		}
		conversation.panel?.followTail();
		void result.completion.catch((error: unknown) => {
			if (this.current !== conversation) return;
			conversation.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			if (!conversation.ctx.ui.getEditorText()) conversation.ctx.ui.setEditorText(text);
		});
		return { handled: true };
	}

	private handleKey(conversation: Conversation, data: string): { consume: true } | undefined {
		if (this.current !== conversation) return undefined;
		const keys = getKeybindings();
		if (keys.matches(data, "app.btw.close")) {
			this.close();
			return { consume: true };
		}
		if (keys.matches(data, "app.btw.cancel")) {
			if (conversation.state.phase === "ready" && conversation.state.conversation.busy)
				conversation.state.conversation.cancel();
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
			const cursor = conversation.ctx.ui.editorHost?.getCursor();
			// The native editor browses history on Up at the start of the draft.
			// Let it keep normal movement within multiline and wrapped drafts.
			if (!cursor || (cursorUp && cursor.line === 0 && cursor.col === 0)) return { consume: true };
		}
		return undefined;
	}
}
