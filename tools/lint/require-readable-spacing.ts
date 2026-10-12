import type { ESTree, Rule } from "@oxlint/plugins";

const BLANK_LINE = /\n[ \t]*\r?\n/;

/** Function overload signatures stay attached to the signature or implementation after them. */
const isOverload = (node: ESTree.Node): boolean =>
  node.type === "TSDeclareFunction" ||
  (node.type === "ExportNamedDeclaration" && node.declaration?.type === "TSDeclareFunction");

const isDirective = (node: ESTree.Node): boolean =>
  node.type === "ExpressionStatement" && "directive" in node && typeof node.directive === "string";

export const requireReadableSpacing: Rule = {
  meta: { type: "layout", fixable: "whitespace" },
  create(context) {
    const { sourceCode } = context;
    const { text } = sourceCode;
    const isMultiline = (node: ESTree.Node) => text.slice(node.start, node.end).includes("\n");

    const checkPair = (previous: ESTree.Node, next: ESTree.Node) => {
      if (isOverload(previous) || isDirective(previous)) return;
      if (previous.type === "ImportDeclaration" && next.type === "ImportDeclaration") return;
      if (!isMultiline(previous) && !isMultiline(next)) return;
      const gap = text.slice(previous.end, next.start);
      // Statements sharing a line are the formatter's concern; a blank line anywhere in the gap counts.
      if (!gap.includes("\n") || BLANK_LINE.test(gap)) return;

      context.report({
        node: next,
        message: "Separate a multiline statement from the statements around it with a blank line.",
        fix: (fixer) => {
          const lineEnd = text.indexOf("\n", previous.end) + 1;
          return fixer.insertTextBeforeRange([lineEnd, lineEnd], "\n");
        },
      });
    };

    const checkList = (nodes: readonly ESTree.Node[]) => {
      nodes.forEach((node, index) => {
        const previous = nodes[index - 1];
        if (previous !== undefined) checkPair(previous, node);
      });
    };

    return {
      Program: (node) => checkList(node.body),
      BlockStatement: (node) => checkList(node.body),
      StaticBlock: (node) => checkList(node.body),
      SwitchCase: (node) => checkList(node.consequent),
      TSModuleBlock: (node) => checkList(node.body),
      ClassBody: (node) => checkList(node.body),
    };
  },
};
