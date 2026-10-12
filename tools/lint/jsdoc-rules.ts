import { basename } from "node:path";
import type { ESTree, Rule } from "@oxlint/plugins";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "for",
  "this",
  "that",
  "is",
  "are",
  "and",
]);

const stem = (word: string): string =>
  word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.replace(/(es|s|ed|ing|e)$/, "");

/** `getUserId` and `get_user_id` both give `get`, `user`, `id`. */
const identifierWords = (name: string): string[] =>
  name
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+/)
    .filter((word) => word !== "")
    .map((word) => stem(word.toLowerCase()));

const proseWords = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter((word) => word !== "" && !STOP_WORDS.has(word))
    .map(stem);

/** True when the text says nothing the name does not. */
const restatesName = (text: string, name: string): boolean => {
  const said = new Set(proseWords(text));
  const named = new Set(identifierWords(name));
  return said.size > 0 && said.size === named.size && [...said].every((word) => named.has(word));
};

const PARAM_TAG = /^@param\s+(?:\{[^}]*\}\s+)?([\w$.]+)\s*-?\s*(.*)$/;

const jsdocLines = (value: string): string[] =>
  value.split("\n").map((line) => line.replace(/^\s*\*+\s?/, "").trim());

const summaryOf = (lines: readonly string[]): string => {
  const end = lines.findIndex((line) => line.startsWith("@"));
  return (end === -1 ? lines : lines.slice(0, end)).join(" ").trim();
};

const restatesParameter = (line: string): boolean => {
  const [, name, description] = PARAM_TAG.exec(line) ?? [];
  return name !== undefined && description !== undefined && restatesName(description, name);
};

const nameOf = (node: ESTree.Node): string | undefined => {
  switch (node.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSEnumDeclaration":
      return node.id?.name;
    case "VariableDeclaration": {
      const [declarator, ...rest] = node.declarations;

      return declarator?.id.type === "Identifier" && rest.length === 0
        ? declarator.id.name
        : undefined;
    }
    case "MethodDefinition":
    case "PropertyDefinition":
    case "TSPropertySignature":
    case "TSMethodSignature":
      return !node.computed && node.key.type === "Identifier" ? node.key.name : undefined;
    default:
      return undefined;
  }
};

const anchorOf = (node: ESTree.Node): ESTree.Node =>
  node.parent?.type === "ExportNamedDeclaration" || node.parent?.type === "ExportDefaultDeclaration"
    ? node.parent
    : node;

export const noRestatingJsdoc: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const { sourceCode } = context;

    const check = (node: ESTree.Node) => {
      const name = nameOf(node);
      if (name === undefined) return;

      const comment = sourceCode.getCommentsBefore(anchorOf(node)).at(-1);
      if (comment?.type !== "Block" || !comment.value.startsWith("*")) return;

      const lines = jsdocLines(comment.value);
      if (!restatesName(summaryOf(lines), name) && !lines.some(restatesParameter)) return;

      context.report({
        loc: {
          start: sourceCode.getLocFromIndex(comment.start),
          end: sourceCode.getLocFromIndex(comment.end),
        },
        message:
          "This JSDoc repeats the name. Delete it, or say what the name cannot: the reason, the limits, the failure cases.",
      });
    };

    return {
      FunctionDeclaration: check,
      ClassDeclaration: check,
      TSInterfaceDeclaration: check,
      TSTypeAliasDeclaration: check,
      TSEnumDeclaration: check,
      VariableDeclaration: check,
      MethodDefinition: check,
      PropertyDefinition: check,
      TSPropertySignature: check,
      TSMethodSignature: check,
    };
  },
};

/** Two plain sentences fit; a third sentence or a list of contents does not. */
const MAX_FILE_DOC_CHARACTERS = 200;

const FOLLOWED_BY_BLANK_LINE = /^[ \t]*\r?\n[ \t]*(\r?\n|$)/;

export const requireFileDoc: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const { sourceCode } = context;
    const start = sourceCode.getLocFromIndex(0);

    const report = (message: string) => {
      context.report({ loc: { start, end: start }, message });
    };

    return {
      Program() {
        const { text } = sourceCode;
        const [first] = sourceCode.getAllComments();

        const isFileDoc =
          first?.type === "Block" &&
          first.value.startsWith("*") &&
          text.slice(0, first.start).trim() === "" &&
          FOLLOWED_BY_BLANK_LINE.test(text.slice(first.end));

        const lines = isFileDoc ? jsdocLines(first.value).filter((line) => line !== "") : [];

        if (lines.length === 0) {
          report(
            "Start the file with a `/** ... */` comment of one or two plain sentences saying what the file is for, then a blank line.",
          );

          return;
        }

        const summary = lines.join(" ");
        const fileName = basename(context.filename).split(".")[0] ?? "";
        const hasTags = lines.some((line) => line.startsWith("@"));

        if (summary.length > MAX_FILE_DOC_CHARACTERS || hasTags) {
          report(
            `Keep the file doc to one or two plain sentences (at most ${MAX_FILE_DOC_CHARACTERS} characters, no tags) about what the file is for.`,
          );
        } else if (restatesName(summary, fileName)) {
          report(
            "The file doc repeats the file name. Say what the file is for and when to use it.",
          );
        }
      },
    };
  },
};
