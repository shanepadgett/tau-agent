import type { ESTree, Rule } from "@oxlint/plugins";

/** `export * from`, `export { name } from`, or `export { name }` with no declaration. */
const isReexport = (statement: ESTree.Node) =>
  statement.type === "ExportAllDeclaration" ||
  (statement.type === "ExportNamedDeclaration" && statement.declaration === null);

export const noReexportOnlyModules: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    return {
      Program(node) {
        const hasReexport = node.body.some(isReexport);

        const isOnlyReexports = node.body.every(
          (statement) => statement.type === "ImportDeclaration" || isReexport(statement),
        );

        if (!hasReexport || !isOnlyReexports) return;

        context.report({
          node,
          message:
            "This module only re-exports other modules. Import each name from the module that defines it.",
        });
      },
    };
  },
};
