import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject } from "./define.ts";

export type JsonStatus =
	| { exists: false; path: string }
	| { exists: true; path: string; ok: true; value: JsonObject }
	| { exists: true; path: string; ok: false; error: string };

const writeQueues = new Map<string, Promise<void>>();

export function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export async function readJsonStatus(path: string): Promise<JsonStatus> {
	try {
		const raw = await readFile(path, "utf8");
		const value = asObject(JSON.parse(raw)) ?? {};
		return { exists: true, path, ok: true, value };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return { exists: false, path };
		return { exists: true, path, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function writeJsonObject(path: string, value: JsonObject): Promise<void> {
	const previous = writeQueues.get(path) ?? Promise.resolve();
	const next = previous.then(async () => {
		await mkdir(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
		await rename(temp, path);
	});
	writeQueues.set(
		path,
		next.catch(() => undefined),
	);
	await next;
}
