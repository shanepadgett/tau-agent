// Display text helpers for TUI components.

export function preview(text: string, max = 80): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatAge(createdAt: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(createdAt).toISOString().slice(0, 10);
}
