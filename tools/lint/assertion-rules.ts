import type { ESTree, Rule, SourceCode } from "@oxlint/plugins";
import { isConstAssertion, isOpenType, type Assertion } from "./type-nodes.ts";

const isAssertion = (node: ESTree.Node): node is Assertion =>
  node.type === "TSAsExpression" || node.type === "TSTypeAssertion";

export const noChainedAssertions: Rule = {
  meta: { type: "problem" },
  create(context) {
    const check = (node: Assertion) => {
      const inner = node.expression;
      if (!isAssertion(inner) || isConstAssertion(node) || isConstAssertion(inner)) return;

      context.report({
        node,
        message:
          "Chained assertions (`as unknown as T`) fabricate a type. Parse the value, or narrow it with a type guard.",
      });
    };

    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

const JUSTIFICATION = /^\s*SAFETY:\s*\S/;

/** Last lines of comment runs that contain a `SAFETY:` justification. */
const justificationLines = (sourceCode: SourceCode): ReadonlySet<number> => {
  const lines = new Set<number>();
  let runEnd = -1;
  let runJustified = false;

  const closeRun = () => {
    if (runJustified) lines.add(runEnd);
  };

  for (const comment of sourceCode.getAllComments()) {
    const start = sourceCode.getLocFromIndex(comment.start).line;

    if (start !== runEnd + 1) {
      closeRun();
      runJustified = false;
    }

    runEnd = sourceCode.getLocFromIndex(comment.end).line;
    runJustified ||= JUSTIFICATION.test(comment.value);
  }

  closeRun();
  return lines;
};

const isStatementLike = (node: ESTree.Node): boolean =>
  node.type.endsWith("Statement") || node.type.endsWith("Declaration");

const enclosingStatement = (node: ESTree.Node): ESTree.Node => {
  let current = node;
  while (!isStatementLike(current) && current.parent !== null) current = current.parent;
  return current;
};

export const requireAssertionJustification: Rule = {
  meta: { type: "problem" },
  create(context) {
    const { sourceCode } = context;
    const lineOf = (offset: number) => sourceCode.getLocFromIndex(offset).line;
    let justified: ReadonlySet<number> | undefined;

    const check = (node: Assertion) => {
      if (isConstAssertion(node)) return;
      justified ??= justificationLines(sourceCode);
      const above = (target: ESTree.Node) => justified?.has(lineOf(target.start) - 1) === true;
      if (above(node) || above(enclosingStatement(node))) return;

      context.report({
        node,
        message:
          "Explain why this assertion holds in a comment directly above it: `// SAFETY: <invariant>`.",
      });
    };

    return { TSAsExpression: check, TSTypeAssertion: check };
  },
};

/** `const input: unknown = value` followed by `input as T` throws the evidence away and claims it back. */
export const noWidenThenAssert: Rule = {
  meta: { type: "problem" },
  create(context) {
    const { sourceCode } = context;

    return {
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.init === null) return;
        const annotation = node.id.typeAnnotation?.typeAnnotation;
        if (annotation === undefined || !isOpenType(annotation)) return;
        const widened = sourceCode.getDeclaredVariables(node);

        for (const variable of widened) {
          for (const reference of variable.references) {
            const parent = reference.identifier.parent;
            if (!isAssertion(parent) || parent.expression !== reference.identifier) continue;

            context.report({
              node: parent,
              message: `\`${node.id.name}\` was widened and is asserted back. Keep the original type, or parse the value.`,
            });
          }
        }
      },
    };
  },
};
