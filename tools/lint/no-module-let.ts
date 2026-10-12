import type { Rule } from "@oxlint/plugins";

export const noModuleLet: Rule = {
  meta: { type: "problem" },
  create(context) {
    return {
      VariableDeclaration(node) {
        if ((node.kind !== "let" && node.kind !== "var") || node.declare === true) return;
        const parent = node.parent;
        const exported = parent.type === "ExportNamedDeclaration" ? parent.parent : parent;
        if (exported.type !== "Program") return;

        context.report({
          node,
          message:
            "Module-level mutable bindings keep state between turns. Keep state in a service or an entry.",
        });
      },
    };
  },
};
