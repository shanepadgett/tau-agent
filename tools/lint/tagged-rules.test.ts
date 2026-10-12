import { testRule } from "./rule-tester.ts";
import { noManualTaggedConstruction, noTagAccess } from "./tagged-rules.ts";

const EFFECT = "import { Match } from 'effect';\n";

testRule("no-tag-access", noTagAccess, {
  valid: [
    EFFECT + "export const name = (value: { name: string }) => value.name;",
    EFFECT + "export const name = (value: { tag: string }) => value.tag;",
    "export const tag = (value: { _tag: string }) => value._tag;",
    "import type { Effect } from 'effect'; export const tag = (value: { _tag: string }) => value._tag;",
    EFFECT + "export type Tagged = { readonly _tag: 'A' };",
  ],
  invalid: [
    {
      code: EFFECT + "export const isA = (value: { _tag: string }) => value._tag === 'A';",
      errors: [{ message: /Reading `_tag`/, line: 2 }],
    },
    { code: EFFECT + "export const tag = (value: { _tag: string }) => value['_tag'];", errors: 1 },
    { code: EFFECT + "export const tag = ({ _tag }: { _tag: string }) => _tag;", errors: 1 },
    {
      code: "import { Option } from 'effect/Option'; export const tag = (value: { _tag: string }) => value._tag;",
      errors: 1,
    },
    {
      code: "import { Effect } from '@effect/platform'; export const tag = (value: { _tag: string }) => value._tag;",
      errors: 1,
    },
  ],
});

testRule("no-manual-tagged-construction", noManualTaggedConstruction, {
  valid: [
    EFFECT + "export const value = { name: 'a' };",
    "export const value = { _tag: 'A' };",
    EFFECT +
      "export const matcher = Match.type<{ _tag: string }>().pipe(Match.when({ _tag: 'A' }, () => 1), Match.orElse(() => 2));",
    EFFECT +
      "export const matcher = Match.type<{ _tag: string }>().pipe(Match.not({ _tag: 'A' }, () => 1), Match.orElse(() => 2));",
  ],
  invalid: [
    {
      code: EFFECT + "export const value = { _tag: 'A', name: 'a' };",
      errors: [{ message: /Writing `_tag`/, line: 2 }],
    },
    { code: EFFECT + "export const value = { '_tag': 'A' };", errors: 1 },
    {
      code: EFFECT + "export const make = (name: string) => ({ _tag: 'A' as const, name });",
      errors: 1,
    },
  ],
});
