import {
  noUnknownReturns,
  noUnknownTypeAliases,
  noUnsafeDictionaryTypes,
} from "./contract-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-unknown-returns", noUnknownReturns, {
  valid: [
    "export const load = (name: string): string => name;",
    "export const later = (name: string): Promise<string> => Promise.resolve(name);",
    "export const many = (): unknown[] => [];",
    "export const infer = (name: string) => name;",
    "export const isName = (value: string): value is 'name' => value === 'name';",
  ],
  invalid: [
    {
      code: "export const load = (name: string): unknown => name;",
      errors: [{ message: /Returning `unknown`/, line: 1, column: 34 }],
    },
    {
      code: "export const later = (name: string): Promise<unknown> => Promise.resolve(name);",
      errors: 1,
    },
    { code: "export async function later(): Promise<unknown | string> { return 1; }", errors: 1 },
    { code: "export const later = (): PromiseLike<unknown> => Promise.resolve(1);", errors: 1 },
    { code: "export const either = (): string | unknown => 'x';", errors: 1 },
  ],
});

testRule("no-unknown-type-aliases", noUnknownTypeAliases, {
  valid: [
    "export type Name = string;",
    "export type Names = unknown[];",
    "export type Handler = (input: unknown) => void;",
  ],
  invalid: [
    {
      code: "export type Anything = unknown;",
      errors: [{ message: /`Anything` hides `unknown`/, line: 1, column: 7 }],
    },
    { code: "type Maybe = string | unknown;", errors: 1 },
  ],
});

testRule("no-unsafe-dictionary-types", noUnsafeDictionaryTypes, {
  valid: [
    "export type Counts = Record<string, number>;",
    "export type Users = Record<string, User>;",
    "export const keep = <T extends Record<string, unknown>>(value: T) => value;",
    "export type Index = { readonly [key: string]: string };",
    "export type Lookup = Map<string, number>;",
  ],
  invalid: [
    {
      code: "export type Bag = Record<string, unknown>;",
      errors: [{ message: /dictionary of/, line: 1, column: 18 }],
    },
    { code: "export type Bag = Record<string, any>;", errors: 1 },
    { code: "export type Bag = Readonly<Record<string, object>>;", errors: 1 },
    { code: "export type Bag = Map<string, {}>;", errors: 1 },
    { code: "export type Bag = ReadonlyMap<string, unknown>;", errors: 1 },
    { code: "export type Index = { readonly [key: string]: unknown };", errors: 1 },
    { code: "export const bag = (value: Record<string, unknown | string>) => value;", errors: 1 },
  ],
});
