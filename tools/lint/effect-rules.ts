import type { ESTree, Rule } from "@oxlint/plugins";
import { createApiResolver, type ApiResolver } from "./api-reference.ts";
import { effectApis, resolvesToApi } from "./effect-api.ts";
import { functionVisitors, type FunctionNode } from "./type-nodes.ts";

const RECOVERY = effectApis(
  "catch",
  "catchCause",
  "catchDefect",
  "catchIf",
  "catchFilter",
  "catchCauseIf",
  "catchCauseFilter",
);

const FALLBACK_VALUE = effectApis("orElseSucceed");
const EMPTY_SUCCESS = effectApis("void");
const SUCCEED = effectApis("succeed");
const GEN = effectApis("gen");

/** `undefined`, `void 0` or `null`. */
const isEmptyValue = (node: ESTree.Node): boolean =>
  (node.type === "Identifier" && node.name === "undefined") ||
  (node.type === "Literal" && node.value === null) ||
  (node.type === "UnaryExpression" && node.operator === "void");

const isEmptySuccess = (resolver: ApiResolver, node: ESTree.Node): boolean => {
  if (resolvesToApi(resolver, node, EMPTY_SUCCESS)) return true;

  if (node.type !== "CallExpression" || !resolvesToApi(resolver, node.callee, SUCCEED))
    return false;

  const [argument] = node.arguments;
  return argument === undefined || isEmptyValue(argument);
};

/** The single expression a function returns, when its body is that trivial. */
export const soleResult = (fn: FunctionNode): ESTree.Node | undefined => {
  const { body } = fn;
  if (body === null || body === undefined) return undefined;
  if (body.type !== "BlockStatement") return body;
  const [statement, ...rest] = body.body;
  if (statement?.type !== "ReturnStatement" || rest.length > 0) return undefined;
  return statement.argument ?? undefined;
};

export const isFunction = (node: ESTree.Node): node is FunctionNode =>
  node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";

export const noSilentErrorSwallow: Rule = {
  meta: { type: "problem" },
  create(context) {
    const resolver = createApiResolver(context);
    const { sourceCode } = context;

    const ignoresError = (handler: FunctionNode): boolean => {
      const [parameter] = handler.params;
      if (parameter === undefined) return true;
      if (parameter.type !== "Identifier") return false;

      const variable = sourceCode
        .getDeclaredVariables(handler)
        .find((candidate) => candidate.name === parameter.name);

      return variable !== undefined && variable.references.length === 0;
    };

    const swallows = (handler: FunctionNode, emptyResult: (node: ESTree.Node) => boolean) => {
      const result = soleResult(handler);
      return result !== undefined && emptyResult(result) && ignoresError(handler);
    };

    return {
      CallExpression(node) {
        const recovers = resolvesToApi(resolver, node.callee, RECOVERY);
        const falls = resolvesToApi(resolver, node.callee, FALLBACK_VALUE);
        if (!recovers && !falls) return;

        const emptyResult = recovers
          ? (result: ESTree.Node) => isEmptySuccess(resolver, result)
          : isEmptyValue;

        for (const argument of node.arguments) {
          if (!isFunction(argument) || !swallows(argument, emptyResult)) continue;

          context.report({
            node: argument,
            message:
              "This handler discards the error and succeeds with nothing. Log it (`Effect.tapError`), handle it by tag (`Effect.catchTag`), or state the intent with `Effect.ignore`.",
          });
        }
      },
    };
  },
};

export const preferEffectFn: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const resolver = createApiResolver(context);

    return functionVisitors((fn) => {
      if (fn.params.length === 0) return;
      const result = soleResult(fn);
      if (result?.type !== "CallExpression" || !resolvesToApi(resolver, result.callee, GEN)) return;

      context.report({
        node: result,
        message:
          'This function only wraps `Effect.gen`. Use `Effect.fn("name")(function* (...) { ... })`, which adds a tracing span and keeps the parameters in one place.',
      });
    });
  },
};

type Frame = { readonly isEffectGen: boolean; yields: number };

export const noYieldlessGen: Rule = {
  meta: { type: "suggestion" },
  create(context) {
    const resolver = createApiResolver(context);
    const frames: Frame[] = [];

    const isEffectGenCallback = (fn: FunctionNode): boolean =>
      fn.type === "FunctionExpression" &&
      fn.generator &&
      fn.parent.type === "CallExpression" &&
      fn.parent.arguments.includes(fn) &&
      resolvesToApi(resolver, fn.parent.callee, GEN);

    const enter = (fn: FunctionNode) => {
      frames.push({ isEffectGen: isEffectGenCallback(fn), yields: 0 });
    };

    const leave = (fn: FunctionNode) => {
      const frame = frames.pop();
      if (frame === undefined || !frame.isEffectGen || frame.yields > 0) return;

      context.report({
        node: fn,
        message: "This `Effect.gen` never yields. Use `Effect.succeed` or `Effect.sync`.",
      });
    };

    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": leave,
      FunctionExpression: enter,
      "FunctionExpression:exit": leave,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": leave,
      YieldExpression() {
        const frame = frames.at(-1);
        if (frame !== undefined) frame.yields += 1;
      },
    };
  },
};
