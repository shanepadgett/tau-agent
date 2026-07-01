export function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

export function normalizeCountLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.floor(value));
}

export function divideBudget(limit: number, count: number): number[] {
	if (count <= 0) return [];
	const base = Math.max(1, Math.floor(limit / count));
	let remainder = Math.max(0, limit - base * count);
	return Array.from({ length: count }, () => {
		const extra = remainder > 0 ? 1 : 0;
		if (remainder > 0) remainder -= 1;
		return base + extra;
	});
}
