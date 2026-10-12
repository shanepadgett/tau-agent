import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createWorkspace } from "./workspace.ts";

type HookCommand = {
  readonly name: string;
  readonly command: string;
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs?: readonly string[];
};

type CommitCommand = { readonly name: string; readonly command: string };

const settings: {
  readonly extensions: {
    readonly silentCommandRunner: {
      readonly afterWrite: readonly HookCommand[];
      readonly afterRun: readonly HookCommand[];
      readonly beforeCommit: readonly CommitCommand[];
    };
  };
} = await Bun.file(new URL("../../.pi/tau/settings.json", import.meta.url)).json();

const hooks = settings.extensions.silentCommandRunner;

// Settings use the host's common * / ** subset, which Bun.Glob also supports.
const matches = (hook: HookCommand, path: string) =>
  hook.includeGlobs.some((glob) => new Bun.Glob(glob).match(path)) &&
  !hook.excludeGlobs?.some((glob) => new Bun.Glob(glob).match(path));

const selected = (path: string) =>
  hooks.afterRun.filter((hook) => matches(hook, path)).map((hook) => hook.command);

describe("development hooks", () => {
  test("route source, plugin, configuration, dependencies and deletions to whole-project checks", () => {
    for (const path of [
      "src/core/agent.ts",
      "src/tui/chat.tsx",
      "tools/lint/tau-plugin.ts",
      "tests/events.test.ts",
      "package.json",
      "bun.lock",
      "mise.toml",
    ]) {
      expect(selected(path)).toEqual(
        expect.arrayContaining([
          "mise run check:lint",
          "mise run check:types",
          "mise run fallow:dead-code",
          "mise run fallow:dupes",
        ]),
      );
    }

    for (const path of [
      ".oxlintrc.json",
      ".oxfmtrc.json",
      ".fallowrc.jsonc",
      ".pi/tau/settings.json",
      "docs/reference/sources.json",
      ".gitignore",
    ]) {
      expect(selected(path)).toContain("mise run check:fmt");
      expect(selected(path)).not.toContain("mise run check:types");
    }

    expect(selected("mise.toml")).toContain("mise run check:mise");

    expect(selected("tsconfig.json")).toEqual([
      "mise run check:fmt",
      "mise run check:lint",
      "mise run check:types",
      "mise run test",
      "mise run fallow:dead-code",
    ]);

    expect(selected("src/core/deleted.ts")).toContain("mise run fallow:dead-code");
    expect(selected("docs/plan/phase-zero.md")).toEqual([]);
    expect(selected("spikes/example/main.ts")).toEqual([]);
  });

  test("run the reference check when dependencies or the reference manifest change", () => {
    for (const path of [
      "docs/reference/sources.json",
      "tools/reference/index-page.ts",
      "tools/reference-check.ts",
      "package.json",
      "bun.lock",
      "mise.toml",
    ]) {
      expect(selected(path)).toContain("mise run check:reference");
    }

    for (const path of ["src/core/agent.ts", "docs/reference/copies/index.md"]) {
      expect(selected(path)).not.toContain("mise run check:reference");
    }
  });

  test("run fast tests after agent runs and the check-infrastructure flow before commits", () => {
    for (const path of ["src/core/agent.ts", "tests/events.test.ts"]) {
      expect(selected(path)).toContain("mise run test");
      expect(selected(path)).not.toContain("mise run test:rules");
    }

    expect(selected("tools/lint/tau-plugin.ts")).toContain("mise run test:rules");
    expect(selected("tools/lint/tau-plugin.ts")).not.toContain("mise run test");

    for (const path of ["package.json", "bun.lock", "mise.toml"]) {
      expect(selected(path)).toContain("mise run test");
      expect(selected(path)).toContain("mise run test:rules");
    }

    for (const path of ["tools/checks/checks.test.ts", ".oxlintrc.json", ".pi/tau/settings.json"]) {
      expect(selected(path)).not.toContain("mise run test:checks");
    }

    expect(hooks.afterRun.map((hook) => hook.command)).not.toContain("mise run test:checks");
    expect(hooks.beforeCommit.map((hook) => hook.command)).toEqual(["mise run test:checks"]);
  });

  test("order lint fixes before formatting and accept each code extension", () => {
    expect(hooks.afterWrite.map((hook) => hook.command)).toEqual([
      "mise run fix:lint -- {files}",
      "mise run fix:fmt -- {files}",
    ]);

    for (const folder of ["src", "tools", "tests"]) {
      for (const extension of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
        expect(
          hooks.afterWrite.every((hook) => matches(hook, `${folder}/nested/file.${extension}`)),
        ).toBe(true);
      }
    }

    expect(
      hooks.afterWrite.filter((hook) => matches(hook, "package.json")).map((hook) => hook.name),
    ).toEqual(["Formatting fixes"]);
  });

  test("configured fixer shell passes awkward names, skips deletions and preserves failures", async () => {
    const path = "tools/it's two words.ts";
    const deleted = "tools/deleted.ts";

    await using workspace = await createWorkspace({
      [path]: "export const value   =  {a:1}\n",
      "tools/untouched.ts": "export const other   =  {a:1}\n",
    });

    for (const hook of hooks.afterWrite) {
      const files = [];

      for (const candidate of [path, deleted]) {
        if (matches(hook, candidate) && (await Bun.file(join(workspace.root, candidate)).exists()))
          files.push(join(workspace.root, candidate));
      }

      // The existing host uses positional parameters, not interpolated shell quoting.
      const result = await workspace.run([
        "sh",
        "-lc",
        hook.command.replaceAll("{files}", '"$@"'),
        "tau-silent-command",
        ...files,
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
    }

    expect(await workspace.read(path)).toBe("export const value = { a: 1 };\n");
    expect(await workspace.read("tools/untouched.ts")).toBe("export const other   =  {a:1}\n");

    await Bun.write(
      join(workspace.root, path),
      "export const run = () => { Promise.resolve(1); };\n",
    );

    const lint = hooks.afterRun.find((hook) => hook.name === "Lint")!;
    const result = await workspace.run(["sh", "-lc", lint.command]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("typescript(no-floating-promises)");
  }, 60_000);
});
