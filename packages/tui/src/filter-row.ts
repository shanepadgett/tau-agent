import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Input, truncateToWidth } from "@earendil-works/pi-tui";

export function renderFilterRow(theme: Theme, input: Input, width: number, active: boolean): string {
	if (!active) {
		const value = input.getValue();
		return truncateToWidth(theme.fg("muted", value ? `> ${value}` : ">"), width, "");
	}
	const body = input.render(Math.max(1, width))[0] ?? "";
	return truncateToWidth(body, width, "");
}
