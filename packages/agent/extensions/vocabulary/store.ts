import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";

export const termSchema = Type.String({ minLength: 1, description: "Product term" });
export const definitionSchema = Type.String({ minLength: 1, description: "Short product-level definition" });
const documentSchema = Type.Object(
	{
		terms: Type.Array(
			Type.Object({ term: termSchema, definition: definitionSchema }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);

export type VocabularyTerm = Static<typeof documentSchema>["terms"][number];

export async function vocabularyPath(cwd: string): Promise<string> {
	return join(await resolveProjectRoot(cwd), ".pi", "tau", "vocabulary.json");
}

export function normalizeVocabularyText(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	if (!normalized) throw new Error("Vocabulary terms and definitions must not be empty");
	return normalized;
}

export async function loadVocabulary(path: string): Promise<VocabularyTerm[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	let document: unknown;
	try {
		document = JSON.parse(raw.replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`Invalid vocabulary JSON: ${path}`);
	}
	if (!Value.Check(documentSchema, document)) {
		throw new Error(`Invalid vocabulary document: ${path}. Expected { terms: [{ term, definition }] }.`);
	}
	const terms = document.terms.map(({ term, definition }) => ({
		term: normalizeVocabularyText(term),
		definition: normalizeVocabularyText(definition),
	}));
	const names = new Set<string>();
	for (const { term } of terms) {
		const key = term.toLowerCase();
		if (names.has(key)) throw new Error(`Duplicate vocabulary term in ${path}: ${term}`);
		names.add(key);
	}
	return terms.sort((a, b) => a.term.localeCompare(b.term, "en"));
}

export async function saveVocabulary(
	path: string,
	terms: VocabularyTerm[],
	signal: AbortSignal | undefined,
): Promise<void> {
	signal?.throwIfAborted();
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(
			temporaryPath,
			`${JSON.stringify({ terms: [...terms].sort((a, b) => a.term.localeCompare(b.term, "en")) }, null, "\t")}\n`,
			{ encoding: "utf8", flag: "wx", signal },
		);
		signal?.throwIfAborted();
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
