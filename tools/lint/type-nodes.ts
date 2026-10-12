import type { ESTree } from "@oxlint/plugins";

export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

export type Assertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

/** Visitor entries that run `handle` on every kind of function. */
export const functionVisitors = (handle: (node: FunctionNode) => void) => ({
  FunctionDeclaration: handle,
  FunctionExpression: handle,
  ArrowFunctionExpression: handle,
  TSDeclareFunction: handle,
});

/** The alternatives of a union, looking through parentheses. A non-union is its own member. */
export const typeMembers = (type: ESTree.TSType): readonly ESTree.TSType[] => {
  if (type.type === "TSParenthesizedType") return typeMembers(type.typeAnnotation);
  if (type.type === "TSUnionType") return type.types.flatMap(typeMembers);
  return [type];
};

const referenceName = (type: ESTree.TSType): string | undefined =>
  type.type === "TSTypeReference" && type.typeName.type === "Identifier"
    ? type.typeName.name
    : undefined;

export const isReferenceTo = (type: ESTree.TSType, ...names: readonly string[]): boolean => {
  const name = referenceName(type);
  return name !== undefined && names.includes(name);
};

export const isConstAssertion = (node: Assertion): boolean =>
  isReferenceTo(node.typeAnnotation, "const");

const isEmptyTypeLiteral = (type: ESTree.TSType): boolean =>
  type.type === "TSTypeLiteral" && type.members.length === 0;

/** `unknown`, alone or as a union member. */
export const isUnknownType = (type: ESTree.TSType): boolean =>
  typeMembers(type).some((member) => member.type === "TSUnknownKeyword");

/** `object` or `{}`, alone or as a union member. */
export const isObjectType = (type: ESTree.TSType): boolean =>
  typeMembers(type).some(
    (member) => member.type === "TSObjectKeyword" || isEmptyTypeLiteral(member),
  );

/** A type that tells the reader nothing about the value: unknown, any, object or `{}`. */
export const isOpenType = (type: ESTree.TSType): boolean =>
  isUnknownType(type) ||
  isObjectType(type) ||
  typeMembers(type).some((member) => member.type === "TSAnyKeyword");

export type Parameter = {
  readonly node: ESTree.Node;
  readonly name: string | undefined;
  readonly type: ESTree.TSType | undefined;
  readonly defaultValue: ESTree.Expression | undefined;
  readonly optional: boolean;
};

const unwrapProperty = (param: ESTree.ParamPattern): ESTree.ParamPattern =>
  param.type === "TSParameterProperty" ? param.parameter : param;

const nameOf = (target: ESTree.Node): string | undefined => {
  if (target.type === "Identifier") return target.name;
  return target.type === "RestElement" ? nameOf(target.argument) : undefined;
};

const annotationOf = (target: ESTree.Node): ESTree.TSType | undefined =>
  "typeAnnotation" in target && target.typeAnnotation?.type === "TSTypeAnnotation"
    ? target.typeAnnotation.typeAnnotation
    : undefined;

/** Name, declared type and default value of a function parameter. */
export const describeParameter = (param: ESTree.ParamPattern): Parameter => {
  const plain = unwrapProperty(param);
  const target = plain.type === "AssignmentPattern" ? plain.left : plain;

  return {
    node: param,
    name: nameOf(target),
    type: annotationOf(target),
    defaultValue: plain.type === "AssignmentPattern" ? plain.right : undefined,
    optional: "optional" in target && target.optional === true,
  };
};

/** The parameter a `value is T` or `asserts value is T` return type narrows, if any. */
export const predicateSubject = (fn: FunctionNode): string | undefined => {
  const annotation = fn.returnType?.typeAnnotation;
  if (annotation?.type !== "TSTypePredicate") return undefined;
  return annotation.parameterName.type === "Identifier" ? annotation.parameterName.name : undefined;
};

const enclosingFunction = (node: ESTree.Node): FunctionNode | undefined => {
  let current: ESTree.Node | null = node.parent;

  while (current !== null) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
};

/** True inside a function declared as a type guard or assertion, where an unparsed value is inspected. */
export const insideTypeGuard = (node: ESTree.Node): boolean =>
  enclosingFunction(node)?.returnType?.typeAnnotation.type === "TSTypePredicate";
