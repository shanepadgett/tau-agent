// Small text helpers shared across extensions.

export { formatAge, preview } from "@shanepadgett/tau-tui";

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function truncAt(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}\n(truncated)` : text;
}
