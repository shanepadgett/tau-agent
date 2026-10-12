import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DocSet, GitRef } from "./manifest.ts";

const TEXT_FILE = /\.(md|mdx|txt|rst|html|ts)$/;

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}):\n${stdout}${stderr}`);
  return stdout.trim();
};

export const relativePath = (path: string): string => {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === ".git" || part === "")
  ) {
    throw new Error(`Expected a relative documentation path: ${path}`);
  }

  return path;
};

const matches = (patterns: readonly string[], file: string): boolean =>
  patterns.some((pattern) => new Bun.Glob(pattern).match(file));

/** Copies the files a set names from `root` into `destination`, keeping their relative paths. */
const copyFiles = async (
  label: string,
  set: DocSet,
  root: string,
  destination: string,
): Promise<number> => {
  if (set.files.length === 0) throw new Error(`No documentation requested for ${label}`);
  const exclude = (set.exclude ?? []).map(relativePath);
  let copied = 0;

  for (const pattern of set.files) {
    relativePath(pattern);
    const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true }));

    if (files.length === 0) throw new Error(`Missing documentation for ${label}: ${pattern}`);

    for (const file of files) {
      relativePath(file);
      if (matches(exclude, file)) continue;

      if (!TEXT_FILE.test(file)) throw new Error(`Not a documentation text file: ${file}`);

      const target = join(destination, file);
      await mkdir(resolve(target, ".."), { recursive: true });
      await cp(join(root, file), target);
      copied += 1;
    }
  }

  return copied;
};

/** The leading path segments of a glob that contain no wildcard. */
const literalPrefix = (pattern: string): string =>
  relativePath(pattern)
    .split("/")
    .filter((_, index, parts) => parts.slice(0, index + 1).every((part) => !part.includes("*")))
    .join("/");

const refName = (ref: GitRef, version: string): string =>
  "tag" in ref ? ref.tag.replaceAll("{version}", version) : ref.branch;

/**
 * Copies one set of docs for a package into `destination`. Returns the commit a Git origin was
 * copied from.
 */
export const fetchDocs = async (
  cwd: string,
  name: string,
  version: string,
  set: DocSet,
  destination: string,
): Promise<string | undefined> => {
  if (set.origin.kind === "installed") {
    const root = join(cwd, "node_modules", name);

    const installed: { readonly version: string } = await Bun.file(
      join(root, "package.json"),
    ).json();

    if (installed.version !== version)
      throw new Error(
        `Installed version mismatch for ${name}: expected ${version}, got ${installed.version}`,
      );

    await copyFiles(name, set, root, destination);
    return undefined;
  }

  const { ref, repository } = set.origin;

  if ("tag" in ref && !ref.tag.includes("{version}"))
    throw new Error(`Missing version in tag pattern for ${name}`);

  const temporary = await mkdtemp(join(tmpdir(), "tau-reference-"));

  try {
    const roots = [...new Set(set.files.map((file) => `/${literalPrefix(file)}`))];

    await git(
      temporary,
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "--no-checkout",
      "--branch",
      refName(ref, version),
      "--",
      repository,
      "repository",
    );

    const root = join(temporary, "repository");
    await git(root, "sparse-checkout", "set", "--no-cone", "--", ...roots);
    await git(root, "checkout", "--detach");
    await copyFiles(name, set, root, destination);
    return await git(root, "rev-parse", "HEAD");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
