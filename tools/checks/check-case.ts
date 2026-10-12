import { expect } from "bun:test";
import { createWorkspace, type Files, type WorkspaceOptions } from "./workspace.ts";

type Expected = { readonly exitCode: number; readonly diagnostics: readonly string[] };

export type Case = {
  readonly name: string;
  readonly files: Files;
  readonly options?: WorkspaceOptions;
  readonly command: readonly string[];
  readonly expected: Expected;
};

export const TIMEOUT = 60_000;

export const task = (name: string, ...files: string[]) =>
  files.length === 0 ? ["mise", "run", name] : ["mise", "run", name, "--", ...files];

/**
 * Lines that carry a diagnostic. Types, lint and Fallow print only diagnostics on
 * stdout; Mise and Fallow progress go to stderr.
 */
const diagnosticLines = (stdout: string) => stdout.split("\n").filter((line) => line.trim() !== "");

export const runCase = async ({ files, options, command, expected }: Case) => {
  await using workspace = await createWorkspace(files, options);
  const result = await workspace.run(command);
  const lines = diagnosticLines(result.stdout);
  const report = `${result.stdout}\n${result.stderr}`;

  for (const diagnostic of expected.diagnostics) {
    expect(
      lines.filter((line) => line.includes(diagnostic)),
      report,
    ).toHaveLength(1);
  }

  expect(lines, report).toHaveLength(expected.diagnostics.length);
  expect(result.exitCode, report).toBe(expected.exitCode);
};
