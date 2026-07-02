import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function renderFilterRow(theme: Theme, input: Input, width: number): string {
	const labelText = "filter: ";
	const label = theme.fg("muted", labelText);
	const body = input.render(Math.max(1, width - visibleWidth(labelText)))[0] ?? "";
	return truncateToWidth(`${label}${body}`, width, "");
}
