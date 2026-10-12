import type { ESTree, Rule } from "@oxlint/plugins";

const MATCH_PATTERNS = new Set(["when", "whenOr", "whenAnd", "not"]);

const isEffectSource = (source: string): boolean =>
  source === "effect" || source.startsWith("effect/") || source.startsWith("@effect/");

/** True for a value import from an Effect package. Type-only imports do not opt a module in. */
const isEffectImport = (node: ESTree.ImportDeclaration): boolean =>
  node.importKind !== "type" && isEffectSource(node.source.value);

const isTagKey = (node: ESTree.Node, computed: boolean): boolean =>
  (!computed && node.type === "Identifier" && node.name === "_tag") ||
  (node.type === "Literal" && node.value === "_tag");

const calleeName = (callee: ESTree.Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;

  return callee.type === "MemberExpression" && callee.property.type === "Identifier"
    ? callee.property.name
    : undefined;
};

/** `Match.when({ _tag: "A" }, ...)` describes a pattern; it does not build a value. */
const isMatchPattern = (node: ESTree.ObjectExpression): boolean => {
  const parent = node.parent;
  if (parent.type !== "CallExpression") return false;
  const name = calleeName(parent.callee);
  return name !== undefined && MATCH_PATTERNS.has(name);
};

/** Tracks whether the module imports Effect. Imports come first, so uses see the final answer. */
const trackEffectImport = () => {
  let enabled = false;

  return {
    isEffectModule: () => enabled,
    ImportDeclaration: (node: ESTree.ImportDeclaration) => {
      if (isEffectImport(node)) enabled = true;
    },
  };
};

export const noTagAccess: Rule = {
  meta: { type: "problem" },
  create(context) {
    const { isEffectModule, ImportDeclaration } = trackEffectImport();

    const report = (node: ESTree.Node) => {
      if (!isEffectModule()) return;

      context.report({
        node,
        message:
          "Reading `_tag` by hand bypasses the tagged-union helpers. Use `Match.tag`, `Effect.catchTag` or `Predicate.isTagged`.",
      });
    };

    return {
      ImportDeclaration,
      MemberExpression(node) {
        if (isTagKey(node.property, node.computed)) report(node);
      },
      Property(node) {
        if (node.parent.type === "ObjectPattern" && isTagKey(node.key, node.computed)) report(node);
      },
    };
  },
};

export const noManualTaggedConstruction: Rule = {
  meta: { type: "problem" },
  create(context) {
    const { isEffectModule, ImportDeclaration } = trackEffectImport();

    return {
      ImportDeclaration,
      ObjectExpression(node) {
        if (!isEffectModule() || isMatchPattern(node)) return;

        const tagged = node.properties.find(
          (property) => property.type === "Property" && isTagKey(property.key, property.computed),
        );

        if (tagged === undefined) return;

        context.report({
          node: tagged,
          message:
            "Writing `_tag` by hand builds a tagged value without its constructor. Use `Data.taggedEnum`, `Schema.TaggedStruct`, `Schema.TaggedClass` or a tagged error class.",
        });
      },
    };
  },
};
