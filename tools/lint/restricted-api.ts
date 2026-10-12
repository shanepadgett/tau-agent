import type { ESTree, Rule } from "@oxlint/plugins";
import { effectApis } from "./effect-api.ts";
import {
  createApiResolver,
  matchesApi,
  memberPath,
  staticKey,
  unwrap,
  type ApiReference,
} from "./api-reference.ts";

type Restriction = { readonly apis: readonly ApiReference[]; readonly message: string };

const global = (...members: string[]): ApiReference[] =>
  members.map((member) => ({ module: "global", member }));

const from = (module: string, ...members: string[]): ApiReference[] =>
  members.map((member) => ({ module, member }));

const restrictions = {
  "no-effect-run": {
    apis: effectApis(
      "runPromise",
      "runPromiseExit",
      "runPromiseWith",
      "runPromiseExitWith",
      "runSync",
      "runSyncExit",
      "runSyncWith",
      "runSyncExitWith",
      "runFork",
      "runForkWith",
      "runCallback",
      "runCallbackWith",
    ),
    message: "Run Effects only at the edges (cli and sdk). Return the Effect instead.",
  },
  "no-env": {
    apis: [
      ...global("process.env", "Bun.env"),
      ...from("import.meta", "env"),
      ...from("node:process", "env", "default.env"),
      ...from("process", "env", "default.env"),
      ...from("bun", "env"),
    ],
    message: "Read environment variables in host and pass the values in.",
  },
  "no-console": {
    apis: [...global("console"), ...from("node:console", ""), ...from("console", "")],
    message: "Write terminal output from cli only.",
  },
  "no-fetch": {
    apis: global("fetch"),
    message: "Make HTTP requests from ai only.",
  },
  "no-spawn": {
    apis: [
      ...global("Bun.spawn", "Bun.spawnSync", "Bun.$"),
      ...from("bun", "spawn", "spawnSync", "$"),
      ...from("node:child_process", ""),
      ...from("child_process", ""),
    ],
    message: "Start processes from proc only.",
  },
  "no-reflect": {
    apis: global("Reflect.get", "Reflect.apply"),
    message: "Reflect hides types. Read the property or call the function directly.",
  },
  "no-service-option": {
    apis: effectApis("serviceOption"),
    message:
      "`Effect.serviceOption` makes a dependency optional at runtime. Require the service, or provide a default layer.",
  },
  "no-module-mock": {
    apis: [...global("mock.module", "vi.mock"), ...from("bun:test", "mock.module", "vi.mock")],
    message: "Do not mock modules. Inject a real dependency or use the fake provider.",
  },
  "no-sleep": {
    apis: [
      ...global("Bun.sleep", "Bun.sleepSync", "setTimeout", "setInterval"),
      ...from("bun", "sleep", "sleepSync"),
      ...from("node:timers", "setTimeout", "setInterval"),
      ...from("timers", "setTimeout", "setInterval"),
      ...from("node:timers/promises", ""),
      ...from("timers/promises", ""),
    ],
    message: "Do not sleep in tests. Await the event or result instead.",
  },
} satisfies Record<string, Restriction>;

const parentStep = (
  node: ESTree.Node,
  path: ApiReference,
): { node: ESTree.Node; path: ApiReference } | undefined => {
  const parent = node.parent;
  if (parent === null) return undefined;
  if (unwrap(parent) === node) return { node: parent, path };
  if (parent.type !== "MemberExpression" || parent.object !== node) return undefined;
  if (parent.property.type === "PrivateIdentifier") return undefined;
  const key = staticKey(parent.property, parent.computed);
  return key === undefined ? undefined : { node: parent, path: memberPath(path, key) };
};

const restrictedApiRule = (restriction: Restriction): Rule => ({
  meta: { type: "problem" },
  create(context) {
    const resolver = createApiResolver(context);

    const matches = (path: ApiReference | undefined): boolean =>
      path !== undefined && restriction.apis.some((api) => matchesApi(path, api));

    const report = (node: ESTree.Node) => context.report({ node, message: restriction.message });

    // Report each outermost destructured property that reaches a restricted API.
    const visitPattern = (pattern: ESTree.Node, path: ApiReference) => {
      if (pattern.type === "AssignmentPattern") return visitPattern(pattern.left, path);
      if (pattern.type !== "ObjectPattern") return;

      for (const property of pattern.properties) {
        if (property.type !== "Property") continue;
        const key = staticKey(property.key, property.computed);
        if (key === undefined) continue;
        const next = memberPath(path, key);

        if (matches(next)) report(property);
        else visitPattern(property.value, next);
      }
    };

    // Climb member accesses from `start` and report the first path that reaches a restricted API.
    const reportOutermostMatch = (start: ESTree.Node) => {
      let current = start;
      let path = resolver.expression(start);

      while (path !== undefined) {
        if (matches(path)) return report(current);
        const step = parentStep(current, path);
        if (step === undefined) return;
        current = step.node;
        path = step.path;
      }
    };

    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (matches(resolver.importBinding(specifier))) report(specifier);
        }
      },
      VariableDeclarator(node) {
        if (node.init === null || node.id.type === "Identifier") return;
        const path = resolver.expression(node.init);
        if (path !== undefined && !matches(path)) visitPattern(node.id, path);
      },
      Identifier(node) {
        if (!resolver.isReference(node) || matches(resolver.binding(node))) return;
        reportOutermostMatch(node);
      },
      MetaProperty: reportOutermostMatch,
    };
  },
});

export const restrictedApiRules = Object.fromEntries(
  Object.entries(restrictions).map(([name, restriction]) => [name, restrictedApiRule(restriction)]),
);
