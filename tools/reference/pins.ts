import { join } from "node:path";
import type { Source } from "./manifest.ts";

type Lockfile = {
  readonly workspaces: Readonly<
    Record<
      string,
      {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
      }
    >
  >;
  readonly packages: Readonly<Record<string, readonly [string, ...unknown[]]>>;
};

export type Pins = {
  /** Direct dependencies at the version `bun.lock` resolved. */
  readonly packages: Readonly<Record<string, string>>;
  /** Tools pinned in `mise.toml`. */
  readonly tools: Readonly<Record<string, string>>;
};

export const readPins = async (cwd: string): Promise<Pins> => {
  const lock = Bun.JSON5.parse(await Bun.file(join(cwd, "bun.lock")).text()) as Lockfile;

  const mise = Bun.TOML.parse(await Bun.file(join(cwd, "mise.toml")).text()) as {
    readonly tools?: Readonly<Record<string, string>>;
  };

  const workspace = lock.workspaces[""];
  if (!workspace) throw new Error("Missing root workspace in bun.lock");

  const packages: Record<string, string> = {};

  for (const name of Object.keys({ ...workspace.dependencies, ...workspace.devDependencies })) {
    const resolved = lock.packages[name]?.[0];

    if (resolved?.startsWith(`${name}@`) !== true)
      throw new Error(`Missing ${name} in the bun.lock package list`);

    packages[name] = resolved.slice(name.length + 1);
  }

  return { packages, tools: mise.tools ?? {} };
};

export const pinnedVersion = (source: Source, pins: Pins): string | undefined =>
  (source.versionSource === "mise" ? pins.tools : pins.packages)[source.package];

/** Every name the manifest must cover, with its version source. */
export const pinnedNames = (pins: Pins): readonly string[] => [
  ...Object.keys(pins.packages),
  ...Object.keys(pins.tools),
];
