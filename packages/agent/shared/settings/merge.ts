import { asObject } from "./json.ts";

export function mergeSettings<T>(base: T, override: unknown): T {
	return mergeNode(base, override) as T;
}

function mergeNode(base: unknown, override: unknown): unknown {
	if (override === undefined) return clone(base);

	const baseObject = asObject(base);
	const overrideObject = asObject(override);
	if (!baseObject || !overrideObject) return clone(override);

	const merged = { ...baseObject };
	for (const key of Object.keys(overrideObject)) merged[key] = mergeNode(merged[key], overrideObject[key]);
	return merged;
}

function clone(value: unknown): unknown {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
