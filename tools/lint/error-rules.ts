import type { ESTree, Rule } from "@oxlint/plugins";
import { createApiResolver } from "./api-reference.ts";
import { effectApis, resolvesToApi } from "./effect-api.ts";
import { isFunction, soleResult } from "./effect-rules.ts";
import type { FunctionNode } from "./type-nodes.ts";

const CONVERTERS = effectApis("try", "tryPromise");
const MAPPERS = effectApis("mapError");

const MESSAGE =
  "This error replaces the original without keeping it. Pass the caught error as `cause`.";

const isErrorClass = (callee: ESTree.Node): boolean =>
  callee.type === "Identifier" && /(Error|Exception)$/.test(callee.name);

const mentions = (text: string, name: string): boolean =>
  new RegExp(String.raw`(?<![\w$.])${name.replaceAll("$", String.raw`\$`)}(?![\w$])`).test(text);

export const errorNeedsCause: Rule = {
  meta: { type: "problem" },
  create(context) {
    const resolver = createApiResolver(context);
    const { sourceCode } = context;
    const catchParameters: string[] = [];

    const handlerDropsCause = (handler: FunctionNode) => {
      const result = soleResult(handler);
      if (result?.type !== "NewExpression") return;

      const [parameter] = handler.params;

      if (parameter?.type === "Identifier" && mentions(sourceCode.getText(result), parameter.name))
        return;

      context.report({ node: result, message: MESSAGE });
    };

    return {
      CatchClause(node) {
        catchParameters.push(node.param?.type === "Identifier" ? node.param.name : "");
      },
      "CatchClause:exit"() {
        catchParameters.pop();
      },
      ThrowStatement(node) {
        const name = catchParameters.at(-1);
        const { argument } = node;
        if (name === undefined || argument.type !== "NewExpression") return;
        if (!isErrorClass(argument.callee)) return;
        if (name !== "" && mentions(sourceCode.getText(argument), name)) return;

        context.report({ node: argument, message: MESSAGE });
      },
      CallExpression(node) {
        const [first] = node.arguments;

        if (resolvesToApi(resolver, node.callee, MAPPERS)) {
          if (first !== undefined && isFunction(first)) handlerDropsCause(first);
          return;
        }

        if (!resolvesToApi(resolver, node.callee, CONVERTERS) || first?.type !== "ObjectExpression")
          return;

        for (const property of first.properties) {
          if (property.type !== "Property" || property.computed) continue;
          if (property.key.type !== "Identifier" || property.key.name !== "catch") continue;
          if (isFunction(property.value)) handlerDropsCause(property.value);
        }
      },
    };
  },
};
