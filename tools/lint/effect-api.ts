import type { ESTree } from "@oxlint/plugins";
import { matchesApi, type ApiReference, type ApiResolver } from "./api-reference.ts";

/** `Effect.<member>` reached through `effect` or `effect/Effect`. */
export const effectApis = (...members: string[]): ApiReference[] => [
  ...members.map((member) => ({ module: "effect", member: `Effect.${member}` })),
  ...members.map((member) => ({ module: "effect/Effect", member })),
];

/** True when `node` resolves to one of `apis`, following aliases and imports. */
export const resolvesToApi = (
  resolver: ApiResolver,
  node: ESTree.Node,
  apis: readonly ApiReference[],
): boolean => {
  const path = resolver.expression(node);
  return path !== undefined && apis.some((api) => matchesApi(path, api));
};
