import type { ESTree, Rule } from "@oxlint/plugins";
import {
  functionVisitors,
  isOpenType,
  isReferenceTo,
  isUnknownType,
  typeMembers,
} from "./type-nodes.ts";

const PROMISE_NAMES = ["Promise", "PromiseLike"];
const DICTIONARY_NAMES = ["Record", "Map", "ReadonlyMap"];

/** `unknown`, or a promise of `unknown`. */
const isUnknownContract = (type: ESTree.TSType): boolean =>
  isUnknownType(type) ||
  typeMembers(type).some(
    (member) =>
      member.type === "TSTypeReference" &&
      isReferenceTo(member, ...PROMISE_NAMES) &&
      member.typeArguments?.params.some(isUnknownType) === true,
  );

export const noUnknownReturns: Rule = {
  meta: { type: "problem" },
  create(context) {
    return functionVisitors((fn) => {
      const annotation = fn.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!isUnknownContract(annotation.typeAnnotation)) return;

      context.report({
        node: annotation,
        message:
          "Returning `unknown` makes every caller guess. Return the parsed type, or a union of the cases.",
      });
    });
  },
};

export const noUnknownTypeAliases: Rule = {
  meta: { type: "problem" },
  create(context) {
    return {
      TSTypeAliasDeclaration(node) {
        if (!isUnknownType(node.typeAnnotation)) return;

        context.report({
          node,
          message: `\`${node.id.name}\` hides \`unknown\` behind a name. Name what the value is.`,
        });
      },
    };
  },
};

/** True inside `T extends Record<string, unknown>`, where an open bound is a constraint, not a value. */
const insideTypeParameter = (node: ESTree.Node): boolean => {
  let current: ESTree.Node | null = node.parent;

  while (current !== null) {
    if (current.type === "TSTypeParameter") return true;
    current = current.parent;
  }

  return false;
};

const DICTIONARY_MESSAGE =
  "A dictionary of `unknown`, `any` or `object` values hides what it holds. Name the value type or list the keys.";

export const noUnsafeDictionaryTypes: Rule = {
  meta: { type: "problem" },
  create(context) {
    const report = (node: ESTree.Node) => {
      if (!insideTypeParameter(node)) context.report({ node, message: DICTIONARY_MESSAGE });
    };

    return {
      TSTypeReference(node) {
        const value = node.typeArguments?.params[1];
        if (!isReferenceTo(node, ...DICTIONARY_NAMES) || value === undefined) return;
        if (isOpenType(value)) report(node);
      },
      TSIndexSignature(node) {
        if (isOpenType(node.typeAnnotation.typeAnnotation)) report(node);
      },
    };
  },
};
