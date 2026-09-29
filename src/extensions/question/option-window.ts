/** One block of rows in the option area: an option, or the notes/custom editor under the list. */
export interface WindowItem {
	height: number;
	countsAsOption: boolean;
}

export interface ItemWindow {
	/** Index of the first and last visible item. */
	first: number;
	last: number;
	/** Rows left for the visible items after reserving the hint rows. */
	contentRows: number;
	showAbove: boolean;
	showBelow: boolean;
	/** Options (not rows) outside the window. */
	hiddenAbove: number;
	hiddenBelow: number;
}

export function moreOptionsHint(direction: "up" | "down", count: number): string {
	const arrow = direction === "up" ? "↑" : "↓";
	if (count <= 0) return `${arrow} more ${direction === "up" ? "above" : "below"}`;
	return `${arrow} ${count} more option${count === 1 ? "" : "s"}`;
}

/**
 * Choose the whole items to show in `rows` rows, keeping `focus` visible. Hint rows
 * ("↑ N more options", "↓ N more options") are reserved only on a side that has
 * hidden items, so a list that starts or ends in view gets that row back.
 * An item taller than the window stays alone; the caller clips its rows.
 */
export function windowItems(items: readonly WindowItem[], focus: number, rows: number): ItemWindow {
	const count = items.length;
	const total = items.reduce((sum, item) => sum + item.height, 0);
	const build = (first: number, last: number, contentRows: number): ItemWindow => ({
		first,
		last,
		contentRows,
		showAbove: first > 0,
		showBelow: last < count - 1,
		hiddenAbove: items.slice(0, first).filter((item) => item.countsAsOption).length,
		hiddenBelow: items.slice(last + 1).filter((item) => item.countsAsOption).length,
	});
	if (total <= rows) return build(0, count - 1, rows);

	const windowFor = (contentRows: number): ItemWindow => {
		let first = focus;
		let last = focus;
		let used = items[focus].height;
		for (let grew = true; grew; ) {
			grew = false;
			if (last + 1 < count && used + items[last + 1].height <= contentRows) {
				last++;
				used += items[last].height;
				grew = true;
			}
			if (first > 0 && used + items[first - 1].height <= contentRows) {
				first--;
				used += items[first].height;
				grew = true;
			}
		}
		return build(first, last, contentRows);
	};

	if (rows <= 2) return { ...windowFor(Math.max(1, rows)), showAbove: false, showBelow: false };
	const window = windowFor(rows - 2);
	if (window.first === 0 || window.last === count - 1) return windowFor(rows - 1);
	return window;
}
