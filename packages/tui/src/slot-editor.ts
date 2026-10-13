import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** Pre-styled text embedded in the editor's border. Empty string leaves a slot bare. */
export interface EditorSlots {
	topLeft: string;
	topCenter: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
}

// Two border cells on each outer edge plus at least three between the left and right slots.
const MIN_FILL = 7;

/**
 * Editor that embeds text in its top and bottom borders, like `── left ──── right ──`.
 * Slots are read at render time. A scroll indicator replaces the slots on that border.
 */
export class SlotEditor extends CustomEditor {
	private readonly readSlots: () => EditorSlots;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, readSlots: () => EditorSlots) {
		super(tui, theme, keybindings);
		this.readSlots = readSlots;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
		const { topLeft, topCenter, topRight } = this.readSlots();
		return this.embed(width, topLeft, topCenter, topRight);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (hiddenLineCount > 0) return super.renderBottomBorder(width, hiddenLineCount);
		const { bottomLeft, bottomRight } = this.readSlots();
		return this.embed(width, bottomLeft, "", bottomRight);
	}

	private embed(width: number, left: string, center: string, right: string): string {
		if (!left && !center && !right) return this.borderColor("─".repeat(width));
		const room = Math.max(0, width - MIN_FILL);
		let leftText = left ? ` ${left} ` : "";
		let rightText = right ? ` ${right} ` : "";
		// The left slot keeps its room; the right slot gives way first.
		rightText = truncateToWidth(rightText, Math.max(0, room - visibleWidth(leftText)), "");
		leftText = truncateToWidth(leftText, room, "");
		const leftEnd = 2 + visibleWidth(leftText);
		const rightStart = width - 2 - visibleWidth(rightText);
		const centerText = center ? ` ${center} ` : "";
		const centerWidth = visibleWidth(centerText);
		// The center slot sits on the border's midpoint, slides away from a neighbor, and is omitted when it cannot fit.
		const centerStart = Math.max(
			leftEnd + 1,
			Math.min(Math.floor((width - centerWidth) / 2), rightStart - 1 - centerWidth),
		);
		const middle =
			centerWidth > 0 && centerStart + centerWidth <= rightStart - 1
				? `${this.borderColor("─".repeat(centerStart - leftEnd))}${centerText}${this.borderColor("─".repeat(rightStart - centerStart - centerWidth))}`
				: this.borderColor("─".repeat(Math.max(0, rightStart - leftEnd)));
		return truncateToWidth(
			`${this.borderColor("──")}${leftText}${middle}${rightText}${this.borderColor("──")}`,
			width,
			"",
		);
	}
}
