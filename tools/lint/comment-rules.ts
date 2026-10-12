import type { Rule } from "@oxlint/plugins";

/** Verbs that open a comment restating the next line of code. */
const NARRATING_VERBS = new Set([
  "add",
  "assign",
  "call",
  "check",
  "create",
  "declare",
  "decrement",
  "define",
  "export",
  "get",
  "handle",
  "import",
  "increment",
  "initialize",
  "instantiate",
  "invoke",
  "iterate",
  "loop",
  "print",
  "remove",
  "return",
  "set",
  "update",
]);

/** A comment that gives a reason is not narration. */
const REASONING =
  /\b(because|since|so that|otherwise|unless|why|but|until|instead|avoid|must|never)\b/i;

const DIRECTIVE = /^(SAFETY|TODO|FIXME|NOTE|HACK|eslint|oxlint|@ts-|prettier|biome|#)/i;

const MAX_WORDS = 6;

export const noNarrationComments: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const { sourceCode } = context;

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== "Line") continue;
          const text = comment.value.trim();
          const words = text.split(/\s+/);
          const verb = words[0]?.toLowerCase();
          if (verb === undefined || !NARRATING_VERBS.has(verb) || DIRECTIVE.test(text)) continue;
          if (words.length > MAX_WORDS || REASONING.test(text)) continue;

          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(comment.start),
              end: sourceCode.getLocFromIndex(comment.end),
            },
            message:
              "This comment restates the next line. Delete it, or say why the code does what it does.",
          });
        }
      },
    };
  },
};

const COMMENTED_CODE = [
  /^(import|export)\b.*\bfrom\s+["']/,
  /^(const|let|var)\s+[\w$[{].*=/,
  /^(return|throw|await|yield)\b.*;$/,
  /^(if|for|while|switch)\s*\(.*\)\s*\{?$/,
  /^(function|class|interface|enum)\s+[\w$]+.*[{(]$/,
  /^[\w$.]+(\?\.)?\(.*\);?$/,
  /^[\w$.[\]]+\s*(=|\+=|-=)\s*[^=\s].*;$/,
  /^[})\]]+[;,]?$/,
  /^}\s*(else|catch|finally)\b.*\{$/,
];

const commentLines = (comment: { readonly type: string; readonly value: string }): string[] =>
  comment.value.split("\n").map((line) => line.replace(/^\s*\*?\s?/, "").trim());

const isCode = (line: string): boolean => COMMENTED_CODE.some((pattern) => pattern.test(line));

export const noCommentedCode: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const { sourceCode } = context;

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          // JSDoc blocks hold `@example` code on purpose.
          if (comment.type === "Block" && comment.value.startsWith("*")) continue;
          const lines = commentLines(comment).filter((line) => !DIRECTIVE.test(line));
          if (!lines.some(isCode)) continue;

          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(comment.start),
              end: sourceCode.getLocFromIndex(comment.end),
            },
            message:
              "This comment is code. Delete it; version control keeps the old version. If it shows an example, put it in a JSDoc `@example`.",
          });
        }
      },
    };
  },
};

/** Paths, documents and ticket numbers that a reader of the code cannot be expected to have. */
const INTERNAL_REFERENCE = new RegExp(
  [
    String.raw`\bdocs/(plan|standards|reference)\b`,
    String.raw`\bspikes?/`,
    String.raw`\bspike\s+\d+\b`,
    String.raw`\b(AGENTS|architecture|tooling|features|phase-zero|deferred)\.md\b`,
    String.raw`\bphase[ -]zero\b`,
    String.raw`\bbuild step\s+\d+\b`,
    String.raw`\bPR\s*#?\d+\b`,
    String.raw`(?<![\w/&])#\d{2,}\b`,
  ].join("|"),
  "i",
);

export const noInternalReferences: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const { sourceCode } = context;

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (!INTERNAL_REFERENCE.test(comment.value) || /https?:\/\//.test(comment.value))
            continue;

          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(comment.start),
              end: sourceCode.getLocFromIndex(comment.end),
            },
            message:
              "This comment points at a plan, standard, spike or ticket instead of stating the fact. Write the reason here; link only to public sources.",
          });
        }
      },
    };
  },
};
