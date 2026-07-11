const MAX_TIMEOUT_SECONDS = 600;

export function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	const effective = value === undefined || !Number.isFinite(value) ? fallback : value;
	return Math.max(minimum, Math.min(Math.floor(effective), maximum));
}

export function normalizeTimeout(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), MAX_TIMEOUT_SECONDS);
}
