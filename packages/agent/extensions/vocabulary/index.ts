import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BoundedTextResultBuilder } from "../../shared/bounded-text-result.ts";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { createTemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { registerToolGroup } from "../../src/tool-loading/index.ts";
import {
	definitionSchema,
	loadVocabulary,
	normalizeVocabularyText,
	saveVocabulary,
	termSchema,
	vocabularyPath,
	type VocabularyTerm,
} from "./store.ts";

const AGREEMENT =
	"Before creating, updating, or deleting vocabulary, discuss the product concept and its definition with the user and reach explicit agreement. Do not infer agreement from implementation work or automatically collect nouns. Register product concepts, not code symbols, file names, or implementation details.";

const parameters = Type.Object(
	{
		operation: Type.Union(
			(["list", "get", "create", "update", "delete"] as const).map((operation) => Type.Literal(operation)),
		),
		term: Type.Optional(
			Type.String({ ...termSchema, description: "Required except for list; existing term for update" }),
		),
		replacementTerm: Type.Optional(
			Type.String({ ...termSchema, description: "Required for update; replacement spelling" }),
		),
		definition: Type.Optional(
			Type.String({
				...definitionSchema,
				description: "Required for create and update; short product-level definition",
			}),
		),
	},
	{ additionalProperties: false },
);

export default function vocabularyExtension(pi: ExtensionAPI): void {
	const temporaryOutput = createTemporaryOutputStore();
	registerPromptSource(pi, {
		key: "vocabulary/terms",
		section: "vocabulary",
		refresh: "append",
		async read(ctx) {
			const terms = await loadVocabulary(await vocabularyPath(ctx.cwd));
			if (terms.length === 0) return "";
			return [
				"Use these product terms consistently:",
				...terms.map(({ term }) => `- ${term}`),
				"",
				"To manage vocabulary, use tool_search to load vocabulary; discuss and agree on every change with the user before saving it.",
			].join("\n");
		},
	});
	registerToolGroup(pi, {
		id: "vocabulary",
		exposure: "deferred",
		description:
			"Manage user-agreed product vocabulary. Discuss changes with the user first; do not collect incidental nouns or implementation details.",
		tools: [
			defineTool({
				name: "vocabulary",
				label: "Vocabulary",
				description: `List, read, create, update, or delete product terms in .pi/tau/vocabulary.json. ${AGREEMENT} Use create for new terms; update requires an existing term and its replacement spelling and definition. Term lookup is case-insensitive. Large results include a session temporary-file path.`,
				parameters,
				executionMode: "sequential",
				annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					const path = await vocabularyPath(ctx.cwd);
					const output = new BoundedTextResultBuilder(temporaryOutput, "completeBlocks");
					try {
						const result = await withFileMutationQueue(path, async () => {
							signal?.throwIfAborted();
							const terms = await loadVocabulary(path);
							if (params.operation === "list") return { terms, message: "" };
							const term = normalizeVocabularyText(params.term ?? "");
							const key = term.toLowerCase();
							const index = terms.findIndex((entry) => entry.term.toLowerCase() === key);
							const existing = terms[index];
							let changed: VocabularyTerm;
							if (params.operation === "get" || params.operation === "delete") {
								if (!existing) throw new Error(`Vocabulary term not found: ${term}`);
								if (params.operation === "get") return { terms: [existing], message: "" };
								changed = existing;
								terms.splice(index, 1);
							} else {
								if (params.operation === "create" && existing)
									throw new Error(`Vocabulary term already exists: ${term}. Use update.`);
								if (params.operation === "update" && !existing)
									throw new Error(`Vocabulary term not found: ${term}`);
								changed = {
									term: normalizeVocabularyText(
										params.operation === "update" ? (params.replacementTerm ?? "") : term,
									),
									definition: normalizeVocabularyText(params.definition ?? ""),
								};
								if (
									terms.some(
										(entry, position) =>
											position !== index && entry.term.toLowerCase() === changed.term.toLowerCase(),
									)
								) {
									throw new Error(`Vocabulary term already exists: ${changed.term}`);
								}
								if (params.operation === "create") terms.push(changed);
								else terms.splice(index, 1, changed);
							}
							await saveVocabulary(path, terms, signal);
							return {
								terms: [changed],
								message: `Vocabulary ${params.operation} saved. The prompt section refreshes on the next agent run.`,
							};
						});
						if (result.message) await output.appendBlock(undefined, "Status", result.message);
						if (result.terms.length === 0)
							await output.appendBlock(undefined, "Status", "No vocabulary terms registered.");
						for (const { term, definition } of result.terms) {
							signal?.throwIfAborted();
							await output.appendBlock(term, "Vocabulary term", `${term}: ${definition}`);
						}
						signal?.throwIfAborted();
						const bounded = await output.finish();
						return {
							content: [{ type: "text", text: bounded.content }],
							details: { operation: params.operation, path, overflow: bounded.overflow },
						};
					} catch (error) {
						await output.abort();
						throw error;
					}
				},
			}),
		],
	});
	pi.on("session_start", async () => {
		await temporaryOutput.shutdown();
		await temporaryOutput.start();
	});
	pi.on("session_shutdown", async () => {
		await temporaryOutput.shutdown();
	});
}
