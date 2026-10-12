import type { Context, ESTree, Reference, Variable } from "@oxlint/plugins";

/**
 * A statically known API path. `module` is an import specifier, `global` for
 * global bindings, or `import.meta`. `member` is the dotted path inside it;
 * an empty member means the module itself.
 */
export type ApiReference = { readonly module: string; readonly member: string };

type ImportBinding =
  | ESTree.ImportSpecifier
  | ESTree.ImportDefaultSpecifier
  | ESTree.ImportNamespaceSpecifier;

export type ApiResolver = {
  /** Path of an expression, following const aliases, destructuring and imports. */
  readonly expression: (node: ESTree.Node) => ApiReference | undefined;
  /** Path of a local binding when it aliases an API, otherwise undefined. */
  readonly binding: (identifier: ESTree.Node) => ApiReference | undefined;
  /** True when the identifier is a value reference rather than a declaration or key. */
  readonly isReference: (identifier: ESTree.Node) => boolean;
  readonly importBinding: (specifier: ImportBinding) => ApiReference | undefined;
};

const GLOBAL = "global";
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);

export const matchesApi = (actual: ApiReference, expected: ApiReference): boolean =>
  actual.module === expected.module &&
  (expected.member === "" ||
    actual.member === expected.member ||
    actual.member.startsWith(`${expected.member}.`));

export const memberPath = (base: ApiReference, key: string): ApiReference => {
  if (base.module === GLOBAL && GLOBAL_OBJECTS.has(base.member)) {
    return { module: GLOBAL, member: key };
  }

  return { module: base.module, member: base.member === "" ? key : `${base.member}.${key}` };
};

export const staticKey = (node: ESTree.Node, computed: boolean): string | undefined => {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;

  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
};

/** Returns the wrapped expression for nodes that do not change the referenced value. */
export const unwrap = (node: ESTree.Node): ESTree.Node | undefined => {
  switch (node.type) {
    case "ChainExpression":
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
      return node.expression;
    default:
      return undefined;
  }
};

/** Keys from a destructuring pattern down to `target`, or undefined when not static. */
const patternKeys = (pattern: ESTree.Node, target: ESTree.Node): string[] | undefined => {
  if (pattern === target) return [];
  if (pattern.type === "AssignmentPattern") return patternKeys(pattern.left, target);
  if (pattern.type !== "ObjectPattern") return undefined;

  for (const property of pattern.properties) {
    if (property.type !== "Property") continue;
    const key = staticKey(property.key, property.computed);
    const rest = patternKeys(property.value, target);
    if (rest !== undefined) return key === undefined ? undefined : [key, ...rest];
  }

  return undefined;
};

export const createApiResolver = (context: Context): ApiResolver => {
  let references: Map<ESTree.Node, Reference> | undefined;

  const referenceOf = (identifier: ESTree.Node): Reference | undefined => {
    if (references === undefined) {
      references = new Map();

      for (const scope of context.sourceCode.scopeManager.scopes) {
        for (const reference of scope.references) references.set(reference.identifier, reference);
      }
    }

    return references.get(identifier);
  };

  const importBinding = (specifier: ImportBinding): ApiReference | undefined => {
    const declaration = specifier.parent;

    if (declaration.type !== "ImportDeclaration" || declaration.importKind === "type") {
      return undefined;
    }

    const module = declaration.source.value;

    switch (specifier.type) {
      case "ImportSpecifier": {
        if (specifier.importKind === "type") return undefined;
        const imported = specifier.imported;
        return { module, member: imported.type === "Identifier" ? imported.name : imported.value };
      }
      case "ImportDefaultSpecifier":
        return { module, member: "default" };
      case "ImportNamespaceSpecifier":
        return { module, member: "" };
    }
  };

  const variablePath = (variable: Variable, seen: Set<Variable>): ApiReference | undefined => {
    if (variable.defs.length === 0) return { module: GLOBAL, member: variable.name };
    const definition = variable.defs[0];

    if (variable.defs.length !== 1 || definition === undefined || seen.has(variable)) {
      return undefined;
    }

    const node = definition.node;

    if (definition.type === "ImportBinding") {
      return node.type === "ImportSpecifier" ||
        node.type === "ImportDefaultSpecifier" ||
        node.type === "ImportNamespaceSpecifier"
        ? importBinding(node)
        : undefined;
    }

    if (definition.type !== "Variable" || node.type !== "VariableDeclarator" || !node.init) {
      return undefined;
    }

    if (variable.references.some((reference) => reference.isWrite() && !reference.init)) {
      return undefined;
    }

    seen.add(variable);
    const base = expressionPath(node.init, seen);
    const keys = patternKeys(node.id, definition.name);
    return base === undefined || keys === undefined ? undefined : keys.reduce(memberPath, base);
  };

  const expressionPath = (node: ESTree.Node, seen: Set<Variable>): ApiReference | undefined => {
    const inner = unwrap(node);
    if (inner !== undefined) return expressionPath(inner, seen);

    switch (node.type) {
      case "Identifier": {
        const reference = referenceOf(node);
        if (reference === undefined) return undefined;

        return reference.resolved === null
          ? { module: GLOBAL, member: node.name }
          : variablePath(reference.resolved, seen);
      }
      case "MemberExpression": {
        if (node.property.type === "PrivateIdentifier") return undefined;
        const key = staticKey(node.property, node.computed);
        const base = expressionPath(node.object, seen);
        return base === undefined || key === undefined ? undefined : memberPath(base, key);
      }
      case "MetaProperty":
        return node.meta.name === "import" && node.property.name === "meta"
          ? { module: "import.meta", member: "" }
          : undefined;
      default:
        return undefined;
    }
  };

  return {
    expression: (node) => expressionPath(node, new Set()),
    binding: (identifier) => {
      const variable = referenceOf(identifier)?.resolved;
      return variable && variable.defs.length > 0 ? variablePath(variable, new Set()) : undefined;
    },
    isReference: (identifier) => referenceOf(identifier) !== undefined,
    importBinding,
  };
};
