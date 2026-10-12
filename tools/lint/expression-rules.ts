import type { ESTree, Rule } from "@oxlint/plugins";
import { insideTypeGuard } from "./type-nodes.ts";

const EQUALITY = new Set(["==", "===", "!=", "!=="]);

const isStringLiteral = (node: ESTree.Node, text: string): boolean =>
  node.type === "Literal" && node.value === text;

/** `typeof x === "undefined"` probes for a missing binding, not a value's shape. */
const isUndefinedProbe = (node: ESTree.UnaryExpression): boolean => {
  const parent = node.parent;
  if (parent.type !== "BinaryExpression" || !EQUALITY.has(parent.operator)) return false;
  return isStringLiteral(parent.left, "undefined") || isStringLiteral(parent.right, "undefined");
};

export const noRuntimeTypeof: Rule = {
  meta: { type: "problem" },
  create(context) {
    return {
      UnaryExpression(node) {
        if (node.operator !== "typeof" || isUndefinedProbe(node)) return;

        // A type guard is where an unparsed value is allowed to be inspected.
        if (insideTypeGuard(node)) return;

        context.report({
          node,
          message:
            "Ad hoc `typeof` checks scatter validation. Parse the value with Schema, or move the check into a type guard.",
        });
      },
    };
  },
};

const isEmptyObject = (node: ESTree.Node): boolean =>
  node.type === "ObjectExpression" && node.properties.length === 0;

export const noConditionalEmptySpread: Rule = {
  meta: { type: "problem" },
  create(context) {
    return {
      SpreadElement(node) {
        if (node.parent.type !== "ObjectExpression") return;
        const spread = node.argument;

        const conditional =
          spread.type === "ConditionalExpression" &&
          (isEmptyObject(spread.consequent) || isEmptyObject(spread.alternate));

        const guarded = spread.type === "LogicalExpression" && spread.operator === "&&";
        if (!conditional && !guarded) return;

        context.report({
          node,
          message:
            "Spreading a conditional object hides which keys exist. Declare the property as `T | undefined`, or build the object in steps.",
        });
      },
    };
  },
};

const LAZY_SOURCES = new Set(["values", "keys", "entries"]);

/** The method name and receiver of `receiver.name(...)`. */
const methodCall = (node: ESTree.Node) => {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return undefined;
  const { object, property, computed } = node.callee;
  if (computed || property.type !== "Identifier") return undefined;
  return { name: property.name, receiver: object };
};

const isIteratorFrom = (node: ESTree.Node): boolean =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "Iterator";

/** True when the chain starts from an iterator, where filter and map are lazy. */
const startsLazy = (chain: ESTree.Node): boolean => {
  let current = chain;

  for (let call = methodCall(current); call !== undefined; call = methodCall(current)) {
    if (LAZY_SOURCES.has(call.name) || isIteratorFrom(current)) return true;
    current = call.receiver;
  }

  return isIteratorFrom(current);
};

const PASS_PAIRS: Readonly<Record<string, string>> = { map: "filter", filter: "map" };

export const noArrayFilterMap: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    return {
      CallExpression(node) {
        const outer = methodCall(node);
        const inner = outer === undefined ? undefined : methodCall(outer.receiver);
        if (outer === undefined || inner === undefined) return;
        if (PASS_PAIRS[outer.name] !== inner.name || startsLazy(outer.receiver)) return;

        context.report({
          node,
          message:
            "`filter` and `map` in sequence make two passes and an intermediate array. Use `flatMap`, a loop, or a lazy iterator (`.values().filter(...).map(...).toArray()`).",
        });
      },
    };
  },
};

export const noInOperator: Rule = {
  meta: { type: "problem" },
  create(context) {
    return {
      BinaryExpression(node) {
        // `#field in value` is a brand check. The runtime tree gives it a PrivateIdentifier on the
        // left, which the published types omit, so compare as a string.
        const leftType: string = node.left.type;
        if (node.operator !== "in" || leftType === "PrivateIdentifier") return;
        if (insideTypeGuard(node)) return;

        context.report({
          node,
          message:
            "Probing keys with `in` guesses at a shape. Parse the value into a discriminated type, or move the check into a type guard.",
        });
      },
    };
  },
};
