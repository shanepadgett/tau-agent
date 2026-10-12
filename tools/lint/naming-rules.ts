import type { ESTree, Rule } from "@oxlint/plugins";
import { describeParameter, functionVisitors } from "./type-nodes.ts";

/** Names that describe nothing about the value. */
const VAGUE_NAMES = new Set([
  "data",
  "temp",
  "tmp",
  "result",
  "results",
  "res",
  "ret",
  "obj",
  "thing",
  "stuff",
  "info",
  "val",
  "foo",
  "bar",
  "baz",
]);

export const noVagueIdentifiers: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const check = (node: ESTree.Node, name: string | undefined) => {
      if (name === undefined || !VAGUE_NAMES.has(name)) return;

      context.report({
        node,
        message: `\`${name}\` says nothing about the value. Name what it holds.`,
      });
    };

    return {
      VariableDeclarator(node) {
        if (node.id.type === "Identifier") check(node.id, node.id.name);
      },
      ...functionVisitors((fn) => {
        for (const param of fn.params) {
          const { name } = describeParameter(param);
          check(param, name);
        }
      }),
    };
  },
};
