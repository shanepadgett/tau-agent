import {
  noArrayFilterMap,
  noConditionalEmptySpread,
  noInOperator,
  noRuntimeTypeof,
} from "./expression-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-runtime-typeof", noRuntimeTypeof, {
  valid: [
    "export const missing = () => typeof process === 'undefined';",
    "export const present = () => 'undefined' !== typeof process;",
    "export const isText = (value: string | number): value is string => typeof value === 'string';",
    "export function assertText(value: string | number): asserts value is string { if (typeof value !== 'string') throw new Error('x'); }",
    "export const kind = (value: string) => value.length;",
    "export type Config = typeof defaults;",
  ],
  invalid: [
    {
      code: "export const isText = (value: string | number) => typeof value === 'string';",
      errors: [{ message: /Ad hoc `typeof`/, line: 1, column: 50 }],
    },
    { code: "export const kind = (value: string | number) => typeof value;", errors: 1 },
    {
      code: "export const kind = (value: string | number) => { switch (typeof value) { default: return 1; } };",
      errors: 1,
    },
    {
      code: "export const isText = (value: string | number) => typeof value === 'string' || typeof value === 'number';",
      errors: 2,
    },
    {
      code: "export const check = (value: string | number) => { const guard = (inner: string): inner is string => typeof inner === 'string'; return typeof value === 'string' && guard('x'); };",
      errors: 1,
    },
  ],
});

testRule("no-conditional-empty-spread", noConditionalEmptySpread, {
  valid: [
    "export const options = { ...defaults, timeout };",
    "export const options = { ...(settings ?? {}) };",
    "export const items = [...(flag ? ['a'] : [])];",
    "export const options = { ...(flag ? { a: 1 } : { b: 2 }) };",
    "export const options = flag ? { timeout } : {};",
  ],
  invalid: [
    {
      code: "export const options = { ...(timeout === undefined ? {} : { timeout }) };",
      errors: [{ message: /conditional object/, line: 1, column: 25 }],
    },
    { code: "export const options = { ...(flag ? { flag } : {}) };", errors: 1 },
    { code: "export const options = { ...(flag && { flag }) };", errors: 1 },
  ],
});

testRule("no-array-filter-map", noArrayFilterMap, {
  valid: [
    "export const names = items.map((item) => item.name);",
    "export const active = items.filter((item) => item.on);",
    "export const names = items.flatMap((item) => (item.on ? [item.name] : []));",
    "export const names = items.filter((item) => item.on).filter((item) => item.name);",
    "export const names = items.values().filter((item) => item.on).map((item) => item.name).toArray();",
    "export const names = map.entries().map(([key]) => key).filter((key) => key).toArray();",
    "export const names = Iterator.from(items).filter((item) => item.on).map((item) => item.name).toArray();",
    "export const names = items.filter((item) => item.on).length;",
  ],
  invalid: [
    {
      code: "export const names = items.filter((item) => item.on).map((item) => item.name);",
      errors: [{ message: /two passes/, line: 1, column: 21 }],
    },
    {
      code: "export const names = items.map((item) => item.name).filter((name) => name !== '');",
      errors: 1,
    },
    {
      code: "export const names = items.slice().filter((item) => item.on).map((item) => item.name).join(',');",
      errors: 1,
    },
  ],
});

testRule("no-in-operator", noInOperator, {
  valid: [
    "export const has = (owner: { name?: string }) => owner.name !== undefined;",
    "export class Box { #field = 1; static has(value: object) { return #field in value; } }",
    "export const isNamed = (value: object): value is { name: string } => 'name' in value;",
    "for (const key in owner) use(key);",
  ],
  invalid: [
    {
      code: "export const has = (owner: { name?: string }) => 'name' in owner;",
      errors: [{ message: /Probing keys/, line: 1, column: 49 }],
    },
    { code: "export const has = (owner: object, key: string) => key in owner;", errors: 1 },
    {
      code: "export const check = (owner: object) => { const guard = (inner: object): inner is object => 'a' in inner; return 'b' in owner && guard(owner); };",
      errors: 1,
    },
  ],
});
