import type { Rule } from "@oxlint/plugins";
import {
  describeParameter,
  functionVisitors,
  isObjectType,
  isUnknownType,
  predicateSubject,
  typeMembers,
  type FunctionNode,
  type Parameter,
} from "./type-nodes.ts";

/** Returns the message to report for a parameter, or undefined when it is acceptable. */
type ParameterCheck = (parameter: Parameter, fn: FunctionNode) => string | undefined;

const parameterRule = (check: ParameterCheck): Rule => ({
  meta: { type: "problem" },
  create(context) {
    return functionVisitors((fn) => {
      for (const param of fn.params) {
        const parameter = describeParameter(param);
        const message = check(parameter, fn);
        if (message !== undefined) context.report({ node: parameter.node, message });
      }
    });
  },
});

export const noUnknownParameters = parameterRule(({ name, type }, fn) => {
  if (type === undefined || !isUnknownType(type)) return undefined;
  // Errors arrive untyped, and a type guard exists to take an unparsed value.
  if (name === "cause" || (name !== undefined && name === predicateSubject(fn))) return undefined;
  return "An `unknown` parameter pushes validation onto the caller's reader. Parse at the boundary with Schema and take the parsed type.";
});

export const noObjectParameters = parameterRule(({ type }) =>
  type !== undefined && isObjectType(type)
    ? "`object` and `{}` accept almost anything. Name the properties the function reads."
    : undefined,
);

export const noBooleanParameters = parameterRule(({ type, defaultValue }) => {
  const declared =
    type !== undefined && typeMembers(type).some((m) => m.type === "TSBooleanKeyword");

  const defaulted = defaultValue?.type === "Literal" && typeof defaultValue.value === "boolean";

  return declared || defaulted
    ? "A boolean parameter reads as `fn(x, true)` at the call site. Take an options object with a named field, or split the function."
    : undefined;
});

export const noOptionalParameters = parameterRule(({ optional }) =>
  optional
    ? "An optional parameter hides whether callers meant to omit it. Declare `T | undefined`, or give it a default."
    : undefined,
);
