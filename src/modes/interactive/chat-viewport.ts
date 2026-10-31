import { type Component, ScrollView, type ScrollViewScrollbar, Spacer, VStack } from "@earendil-works/pi-tui";
import {
	findStickyUserMessage,
	type StickyUserMessageAnchor,
	StickyUserMessageComponent,
} from "./components/sticky-user-message.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import type { TranscriptLayoutContainer } from "./transcript-layout.ts";

export interface ChatViewportOptions {
	readonly document: TranscriptLayoutContainer;
	readonly chat: TranscriptLayoutContainer;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
	readonly outputPad?: () => number;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
}

class TranscriptScrollView extends ScrollView {
	onLayout: ((requestRender: () => void) => void) | undefined;

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		this.onLayout?.(requestRender);
	}
}

class ChatTranscriptView {
	readonly root: VStack;
	readonly scrollView: TranscriptScrollView;
	private readonly document: TranscriptLayoutContainer;
	private readonly chat: TranscriptLayoutContainer;
	private readonly padding = new Spacer(1);
	private readonly sticky: StickyUserMessageComponent;
	private paddingTop = 1;

	constructor(options: ChatViewportOptions) {
		this.document = options.document;
		this.chat = options.chat;
		this.sticky = new StickyUserMessageComponent(options.outputPad ?? (() => 1), (row) =>
			this.scrollView.scrollTo(row),
		);
		const content = new VStack([this.padding, this.document]);
		this.scrollView = new TranscriptScrollView(content, {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: options.scrollbar ?? "auto",
			...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
			...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
		});
		this.scrollView.onLayout = (requestRender) => {
			if (this.updateStickyMessage()) requestRender();
		};
		this.root = new VStack([
			{ component: this.sticky, shrink: 0, minSize: 0 },
			{ component: this.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
	}

	private updateStickyMessage(): boolean {
		const judgment =
			this.scrollView.viewportHeight < 2
				? undefined
				: findStickyUserMessage(this.getUserMessageAnchors(), this.scrollView.scrollTop - 1);
		const paddingTop = judgment ? 0 : 1;
		let changed = this.sticky.setJudgment(judgment);
		if (paddingTop !== this.paddingTop) {
			this.paddingTop = paddingTop;
			this.padding.setLines(paddingTop);
			changed = true;
		}
		return changed;
	}

	private getUserMessageAnchors(): StickyUserMessageAnchor[] {
		const documentLayout = this.document.getRenderedLayout();
		const chatLayout = this.chat.getRenderedLayout();
		const chatRow = documentLayout?.children.find((child) => child.component === this.chat)?.row;
		if (chatRow === undefined || !chatLayout) return [];

		const anchors: StickyUserMessageAnchor[] = [];
		for (const child of chatLayout.children) {
			if (!(child.component instanceof UserMessageComponent)) continue;
			const summary = child.component.getNavigationSummary();
			if (!summary) continue;
			anchors.push({
				row: chatRow + child.row + child.component.getNavigationAnchorOffset(chatLayout.width),
				summary,
			});
		}
		return anchors;
	}
}

/** Shared fullscreen transcript, sticky prompt, and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcriptView = new ChatTranscriptView(options);
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	return {
		transcript: transcriptView.scrollView,
		root: new VStack([
			{ component: transcriptView.root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	};
}
