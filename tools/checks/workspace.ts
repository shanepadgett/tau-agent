import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");

/** Production configuration copied into every workspace unchanged. */
const CONFIGURATION = [
  ".fallowrc.jsonc",
  ".gitignore",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "bun.lock",
  "mise.toml",
  "package.json",
  "tsconfig.json",
  "tools",
  "docs/reference/sources.json",
  ".pi/tau/settings.json",
];

export type Files = Readonly<Record<string, string>>;

export type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly maxRSS: number;
};

export type WorkspaceOptions = {
  /** Fields merged over the production package.json, for entries the scaffold does not have yet. */
  readonly package?: Readonly<Record<string, unknown>>;
  /** `link` shares the repository's installed node_modules; `none` leaves tools missing. */
  readonly dependencies?: "link" | "none";
};

export type Workspace = AsyncDisposable & {
  readonly root: string;
  readonly run: (argv: readonly string[]) => Promise<CommandResult>;
  readonly read: (path: string) => Promise<string>;
};

export const createWorkspace = async (
  files: Files,
  options: WorkspaceOptions = {},
): Promise<Workspace> => {
  const root = await mkdtemp(join(tmpdir(), "tau-checks-"));
  const remove = () => rm(root, { recursive: true, force: true });

  try {
    for (const entry of CONFIGURATION) {
      // Tests for the check infrastructure stay in the repository. A workspace keeps an empty
      // tools/checks so the check-infrastructure test task finds its directory.
      const filter = (source: string) =>
        source.endsWith("/tools/checks") ||
        !/(\.test|rule-tester)\.ts$|\/tools\/checks\//.test(source);

      await cp(join(REPOSITORY, entry), join(root, entry), { recursive: true, filter });
    }

    const linked = (options.dependencies ?? "link") === "link";

    if (linked) {
      await symlink(join(REPOSITORY, "node_modules"), join(root, "node_modules"));
    }

    if (options.package !== undefined) {
      const manifest: Record<string, unknown> = await Bun.file(join(root, "package.json")).json();

      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({ ...manifest, ...options.package }),
      );

      // Oxfmt sorts package.json keys; format the merged manifest so it is a clean input.
      if (linked)
        await run(["bunx", "--bun", "--no-install", "oxfmt", "--write", "package.json"], root);
    }

    for (const [path, content] of Object.entries(files)) {
      await Bun.write(join(root, path), content);
    }
  } catch (error) {
    await remove();
    throw error;
  }

  return {
    root,
    run: (argv) => run(argv, root),
    read: (path) => Bun.file(join(root, path)).text(),
    [Symbol.asyncDispose]: remove,
  };
};

/** Runs a real command to completion. Mise must trust the workspace's copied mise.toml. */
const run = async (argv: readonly string[], cwd: string): Promise<CommandResult> => {
  const child = Bun.spawn([...argv], {
    cwd,
    env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr, maxRSS: child.resourceUsage()?.maxRSS ?? 0 };
};
