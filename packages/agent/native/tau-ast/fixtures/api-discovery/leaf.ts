/** Interpolates cursor colors without exposing the implementation body. */
export function interpolateColor(start: string, end: string, amount: number): string {
	return amount < 0.5 ? start : end;
}

/** Contract used by cursor renderers. */
export interface CursorContract {
	color: string;
}
