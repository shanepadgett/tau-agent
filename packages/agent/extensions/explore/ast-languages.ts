import { basename, extname } from "node:path";

export const AST_LANGUAGE_REGISTRY = [
	{
		id: "typescript",
		label: "TypeScript",
		extensions: [".ts"],
		workerLanguage: "typeScript",
	},
	{ id: "tsx", label: "TSX", extensions: [".tsx"], workerLanguage: "tsx" },
	{ id: "odin", label: "Odin", extensions: [".odin"], workerLanguage: "odin" },
	{ id: "go", label: "Go", extensions: [".go"], workerLanguage: "go" },
	{ id: "rust", label: "Rust", extensions: [".rs"], workerLanguage: "rust" },
	{ id: "csharp", label: "C#", extensions: [".cs"], workerLanguage: "cSharp" },
	{ id: "java", label: "Java", extensions: [".java"], workerLanguage: "java" },
	{
		id: "kotlin",
		label: "Kotlin",
		extensions: [".kt", ".ktm", ".kts"],
		workerLanguage: "kotlin",
	},
	{ id: "swift", label: "Swift", extensions: [".swift"], workerLanguage: "swift" },
	{
		id: "markdown",
		label: "Markdown",
		extensions: [".md", ".markdown", ".mdown"],
		workerLanguage: "markdown",
	},
] as const;

export type AstLanguageDefinition = (typeof AST_LANGUAGE_REGISTRY)[number];
export type AstLanguage = AstLanguageDefinition["workerLanguage"];

export function isAstLanguage(value: unknown): value is AstLanguage {
	return AST_LANGUAGE_REGISTRY.some((language) => language.workerLanguage === value);
}

export function astLanguageForPath(path: string): AstLanguage | undefined {
	const extension = extname(basename(path)).toLowerCase();
	for (const language of AST_LANGUAGE_REGISTRY) {
		const extensions: readonly string[] = language.extensions;
		if (extensions.includes(extension)) return language.workerLanguage;
	}
	return undefined;
}

export function requireAstLanguageForPath(path: string): AstLanguage {
	const language = astLanguageForPath(path);
	if (language) return language;
	throw new Error(`Unsupported outline file type: ${extname(path) || "no extension"}`);
}

export function formatAstLanguageLabels(
	languages: readonly Pick<AstLanguageDefinition, "label">[],
	conjunction: "and" | "or",
): string {
	const labels = languages.map((language) => language.label);
	if (labels.length < 2) return labels[0] ?? "";
	if (labels.length === 2) return `${labels[0]} ${conjunction} ${labels[1]}`;
	return `${labels.slice(0, -1).join(", ")}, ${conjunction} ${labels.at(-1)}`;
}
