import {
  noBooleanParameters,
  noObjectParameters,
  noOptionalParameters,
  noUnknownParameters,
} from "./parameter-rules.ts";
import { testRule } from "./rule-tester.ts";

testRule("no-unknown-parameters", noUnknownParameters, {
  valid: [
    "export const parse = (input: string) => input;",
    "export const wrap = (message: string, cause: unknown) => new Error(message, { cause });",
    "export const isName = (value: unknown): value is string => value === 'name';",
    "export function assertText(value: unknown): asserts value is string {}",
    "export const infer = (input = 1) => input;",
    "export const many = (...values: unknown[]) => values;",
  ],
  invalid: [
    {
      code: "export const parse = (input: unknown) => String(input);",
      errors: [{ message: /Parse at the boundary/, line: 1, column: 22 }],
    },
    { code: "export function parse(input: string | unknown) {}", errors: 1 },
    { code: "export const parse = (input: unknown = 1) => input;", errors: 1 },
    { code: "export const parse = ({ name }: unknown) => name;", errors: 1 },
    { code: "export const wrap = (reason: unknown) => reason;", errors: 1 },
    {
      code: "export const isName = (value: unknown, other: unknown): value is string => other === value;",
      errors: 1,
    },
    { code: "export class Reader { read(input: unknown) { return input; } }", errors: 1 },
    { code: "export class Reader { constructor(private readonly input: unknown) {} }", errors: 1 },
  ],
});

testRule("no-object-parameters", noObjectParameters, {
  valid: [
    "export const store = (value: { readonly name: string }) => value;",
    "export const keys = <T extends object>(value: T) => value;",
    "export const names = (value: Record<string, string>) => value;",
  ],
  invalid: [
    {
      code: "export const store = (value: object) => value;",
      errors: [{ message: /`object` and `\{\}`/, line: 1, column: 22 }],
    },
    { code: "export const store = (value: {}) => value;", errors: 1 },
    { code: "export const store = (value: object | undefined) => value;", errors: 1 },
  ],
});

testRule("no-boolean-parameters", noBooleanParameters, {
  valid: [
    "export const named = (options: { readonly enabled: boolean }) => options.enabled;",
    "export const split = (name: string, retries: number) => [name, retries];",
    "export const handler = (callback: (enabled: boolean) => void) => callback;",
  ],
  invalid: [
    {
      code: "export const toggle = (enabled: boolean) => enabled;",
      errors: [{ message: /named field/, line: 1, column: 23 }],
    },
    { code: "export const retry = (attempts = false) => attempts;", errors: 1 },
    { code: "export const maybe = (enabled?: boolean) => enabled;", errors: 1 },
    { code: "export const either = (enabled: boolean | undefined) => enabled;", errors: 1 },
    { code: "export class Gate { open(force: boolean) { return force; } }", errors: 1 },
  ],
});

testRule("no-optional-parameters", noOptionalParameters, {
  valid: [
    "export const greet = (name: string) => name;",
    "export const greet = (name: string | undefined) => name;",
    "export const greet = (name = 'world') => name;",
    "export interface Greeter { greet(name?: string): string }",
    "export type Greet = (name?: string) => string;",
    "export const options = (settings: { readonly name?: string }) => settings.name;",
  ],
  invalid: [
    {
      code: "export const greet = (name?: string) => name;",
      errors: [{ message: /optional parameter/, line: 1, column: 22 }],
    },
    {
      code: "export function greet(first: string, last?: string) { return [first, last]; }",
      errors: 1,
    },
    { code: "export class Greeter { greet(name?: string) { return name; } }", errors: 1 },
    { code: "export const greet = ({ name }?: { name: string }) => name;", errors: 1 },
  ],
});
