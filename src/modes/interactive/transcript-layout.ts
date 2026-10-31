import { type Component, Container } from "@earendil-works/pi-tui";

export interface TranscriptLayoutChild {
	readonly component: Component;
	readonly row: number;
	readonly height: number;
}

export interface TranscriptLayout {
	readonly width: number;
	readonly children: readonly TranscriptLayoutChild[];
}

/**
 * A container that exposes the rows it has already rendered for transcript anchors.
 *
 * Mouse dispatch intentionally keeps using Container's fallback measurement. The
 * layout is observational and never changes rendering or hit-testing behavior.
 */
export class TranscriptLayoutContainer extends Container {
	private renderedLayout: TranscriptLayout | undefined;

	getRenderedLayout(): TranscriptLayout | undefined {
		return this.renderedLayout;
	}

	override clear(): void {
		this.renderedLayout = undefined;
		super.clear();
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		const children: TranscriptLayoutChild[] = [];
		for (const component of this.children) {
			const childLines = component.render(width);
			children.push({ component, row: lines.length, height: childLines.length });
			for (const line of childLines) lines.push(line);
		}
		this.renderedLayout = { width, children };
		return lines;
	}
}
