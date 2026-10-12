import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace, type Files, type Workspace } from "./workspace.ts";

const repository: {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
} = await Bun.file(new URL("../../package.json", import.meta.url)).json();

/** Every direct dependency and pinned tool in the production project. */
const PINNED = [
  ...Object.keys({ ...repository.dependencies, ...repository.devDependencies }),
  "bun",
  "node",
];

const source = (overrides: Record<string, unknown> = {}) => ({
  package: "@effect/tsgo",
  versionSource: "lock",
  summary: "Effect diagnostics.",
  docs: [{ origin: { kind: "installed" }, files: ["README.md"] }],
  api: [],
  ...overrides,
});

/** A manifest that covers `sources` and ignores every other pin. */
const manifest = (...sources: readonly ReturnType<typeof source>[]) =>
  JSON.stringify({
    ignore: PINNED.filter((name) => !sources.some((entry) => entry.package === name)),
    sources,
  });

const sync = ["mise", "run", "docs"];
const check = ["mise", "run", "check:reference"];

const run = async (workspace: Workspace, command: readonly string[]) => {
  const result = await workspace.run(command);
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
};

const write = (workspace: Workspace, path: string, content: string) =>
  Bun.write(join(workspace.root, path), content);

const exists = (workspace: Workspace, path: string) =>
  Bun.file(join(workspace.root, path)).exists();

const files = (entry: ReturnType<typeof source>): Files => ({
  "docs/reference/sources.json": manifest(entry),
});

describe("reference documentation sync", () => {
  test("copies installed docs at the locked version, indexes them and replaces stale copies", async () => {
    await using workspace = await createWorkspace({
      ...files(
        source({
          api: [
            { kind: "schema", path: "@effect/tsgo/schema.json" },
            { kind: "types", path: "bun-types" },
          ],
        }),
      ),
      "docs/reference/copies/stale.md": "old copy",
    });

    const result = await run(workspace, sync);
    expect(result.exitCode, result.output).toBe(0);

    expect(await workspace.read("docs/reference/copies/@effect/tsgo/0.51.1/README.md")).toContain(
      "Effect Language Service",
    );

    const index = await workspace.read("docs/reference/copies/index.md");
    expect(index).toContain("## @effect/tsgo 0.51.1");
    expect(index).toContain("Effect diagnostics.");
    expect(index).toContain("1 file: README.md");
    expect(index).toContain("- API (schema): `node_modules/@effect/tsgo/schema.json`");

    expect(index).toContain(
      "modules: `docs/reference/copies/@effect/tsgo/0.51.1/api-index/bun-types.md`",
    );

    expect(
      await workspace.read("docs/reference/copies/@effect/tsgo/0.51.1/api-index/bun-types.md"),
    ).toContain("- `bun`");

    expect(await workspace.read("docs/reference/copies/versions.json")).toContain('"0.51.1"');
    expect(await exists(workspace, "docs/reference/copies/stale.md")).toBe(false);
  });

  test("lists each module with the first sentence of its doc comment", async () => {
    await using workspace = await createWorkspace({
      ...files(source({ api: [{ kind: "source", path: "effect/src" }] })),
    });

    const result = await run(workspace, sync);
    expect(result.exitCode, result.output).toBe(0);

    expect(
      await workspace.read("docs/reference/copies/@effect/tsgo/0.51.1/api-index/effect-src.md"),
    ).toContain("- `Option`: Models a value that may be present or absent.");
  });

  test("fails for missing versions, missing docs and non-documentation paths without replacing copies", async () => {
    const failures = [
      [source({ package: "missing-package" }), "Missing exact version"],
      [
        source({ docs: [{ origin: { kind: "installed" }, files: ["missing.md"] }] }),
        "Missing documentation",
      ],
      [
        source({ docs: [{ origin: { kind: "installed" }, files: ["package.json"] }] }),
        "Not a documentation text file",
      ],
      [
        source({ docs: [{ origin: { kind: "installed" }, files: ["../README.md"] }] }),
        "Expected a relative documentation path",
      ],
    ] as const;

    for (const [requested, message] of failures) {
      await using workspace = await createWorkspace({
        ...files(requested),
        "docs/reference/copies/retained.md": "previous docs",
      });

      const result = await run(workspace, sync);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(await workspace.read("docs/reference/copies/retained.md")).toBe("previous docs");
    }
  });

  test("rejects a stale installed package version", async () => {
    await using workspace = await createWorkspace(
      {
        ...files(source()),
        "node_modules/@effect/tsgo/package.json": '{"version":"0.0.0"}',
      },
      { dependencies: "none" },
    );

    const result = await run(workspace, sync);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Installed version mismatch");
  });

  test("copies docs from the Git tag or branch, skips excluded files and records the commit", async () => {
    await using workspace = await createWorkspace({
      "upstream/docs/guide.md": "tagged documentation",
      "upstream/docs/internal/notes.md": "internal notes",
      "upstream/source.ts": "source code",
    });

    const upstream = join(workspace.root, "upstream");

    const git = async (...args: string[]) => {
      const result = await workspace.run(["git", ...args]);
      expect(result.exitCode, result.stderr).toBe(0);
    };

    const commit = (message: string) =>
      git(
        "-C",
        upstream,
        "-c",
        "user.name=Tau tests",
        "-c",
        "user.email=tests@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-am",
        message,
      );

    await git("init", "-b", "main", upstream);
    await git("-C", upstream, "add", ".");
    await commit("docs");
    await git("-C", upstream, "tag", "bun-v1.4.3");
    await write(workspace, "upstream/docs/guide.md", "untagged documentation");
    await commit("later");

    const tagged = (ref: Record<string, string>) =>
      source({
        package: "bun",
        versionSource: "mise",
        docs: [
          {
            origin: { kind: "git", repository: `file://${upstream}`, ref },
            files: ["docs/**/*.md"],
            exclude: ["docs/internal/**"],
          },
        ],
      });

    await write(
      workspace,
      "docs/reference/sources.json",
      manifest(tagged({ tag: "bun-v{version}" })),
    );

    const result = await run(workspace, sync);
    expect(result.exitCode, result.output).toBe(0);

    expect(await workspace.read("docs/reference/copies/bun/1.4.3/docs/guide.md")).toBe(
      "tagged documentation",
    );

    expect(await exists(workspace, "docs/reference/copies/bun/1.4.3/source.ts")).toBe(false);

    expect(await exists(workspace, "docs/reference/copies/bun/1.4.3/docs/internal/notes.md")).toBe(
      false,
    );

    expect(await workspace.read("docs/reference/copies/versions.json")).toMatch(/[0-9a-f]{40}/);

    expect(await workspace.read("docs/reference/copies/index.md")).toContain(
      "tag bun-v1.4.3, commit",
    );

    await write(workspace, "docs/reference/sources.json", manifest(tagged({ branch: "main" })));
    const branch = await run(workspace, sync);
    expect(branch.exitCode, branch.output).toBe(0);

    expect(await workspace.read("docs/reference/copies/bun/1.4.3/docs/guide.md")).toBe(
      "untagged documentation",
    );

    expect(await workspace.read("docs/reference/copies/index.md")).toContain("branch main, commit");

    await write(
      workspace,
      "docs/reference/sources.json",
      manifest(tagged({ tag: "missing-{version}" })),
    );

    const missing = await run(workspace, sync);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("missing-1.4.3");

    expect(await workspace.read("docs/reference/copies/bun/1.4.3/docs/guide.md")).toBe(
      "untagged documentation",
    );
  }, 60_000);
});

describe("reference documentation check", () => {
  const synced = async (entry = source()) => {
    const workspace = await createWorkspace(files(entry));
    const result = await run(workspace, sync);
    expect(result.exitCode, result.output).toBe(0);
    return workspace;
  };

  test("passes when every dependency is covered and the copies are current", async () => {
    await using workspace = await synced();
    const result = await run(workspace, check);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  test("fails for a dependency with no source and for sources that match no dependency", async () => {
    await using workspace = await synced();

    await write(
      workspace,
      "docs/reference/sources.json",
      JSON.stringify({
        ignore: PINNED.filter((name) => name !== "oxfmt" && name !== "@effect/tsgo").concat(
          "not-installed",
        ),
        sources: [source({ package: "left-pad" })],
      }),
    );

    const result = await run(workspace, check);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No reference for oxfmt");
    expect(result.stdout).toContain("No reference for @effect/tsgo");
    expect(result.stdout).toContain("ignores not-installed");
    expect(result.stdout).toContain("source for left-pad, which is not pinned");
  });

  test("fails when the copies are missing, older than the pin, or made from an older source", async () => {
    await using workspace = await synced();
    const records = await workspace.read("docs/reference/copies/versions.json");

    await write(
      workspace,
      "docs/reference/copies/versions.json",
      records.replace('"version": "0.51.1"', '"version": "0.50.0"'),
    );

    const older = await run(workspace, check);
    expect(older.exitCode).toBe(1);
    expect(older.stdout).toContain("The docs for @effect/tsgo are 0.50.0 but 0.51.1 is pinned");

    await write(workspace, "docs/reference/copies/versions.json", records);
    await write(workspace, "docs/reference/sources.json", manifest(source({ summary: "New." })));

    const changed = await run(workspace, check);
    expect(changed.exitCode).toBe(1);
    expect(changed.stdout).toContain("changed after its docs were copied");

    await write(workspace, "docs/reference/sources.json", manifest(source()));
    await rm(join(workspace.root, "docs/reference/copies"), { recursive: true });

    const missing = await run(workspace, check);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("docs/reference/copies is missing");
  });

  test("fails for an API path that does not exist and for an index that no longer matches", async () => {
    await using workspace = await synced(
      source({ api: [{ kind: "schema", path: "@effect/tsgo/schema.json" }] }),
    );

    await write(workspace, "docs/reference/copies/index.md", "edited by hand");

    const edited = await run(workspace, check);
    expect(edited.exitCode).toBe(1);
    expect(edited.stdout).toContain("docs/reference/copies/index.md is out of date");

    await write(
      workspace,
      "docs/reference/sources.json",
      manifest(source({ api: [{ kind: "schema", path: "@effect/tsgo/gone.json" }] })),
    );

    const gone = await run(workspace, check);
    expect(gone.exitCode).toBe(1);
    expect(gone.stdout).toContain("API path node_modules/@effect/tsgo/gone.json does not exist");
  });
});
