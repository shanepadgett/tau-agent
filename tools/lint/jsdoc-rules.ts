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
