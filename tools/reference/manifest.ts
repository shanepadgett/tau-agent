import { join } from "node:path";

export type GitRef = { readonly tag: string } | { readonly branch: string };

export type DocSet = {
  readonly origin:
    | { readonly kind: "installed" }
    | { readonly kind: "git"; readonly repository: string; readonly ref: GitRef };
  readonly files: readonly string[];
  readonly exclude?: readonly string[];
};

/** A file or folder the package already installs. `path` is relative to `node_modules`. */
export type ApiPointer = {
  readonly kind: "source" | "types" | "schema";
  readonly path: string;
};

export type Source = {
  readonly package: string;
  readonly versionSource: "lock" | "mise";
  readonly summary: string;
  readonly docs: readonly DocSet[];
  readonly api: readonly ApiPointer[];
};

export type Manifest = {
  /** Direct dependencies and tools that need no reference. */
  readonly ignore: readonly string[];
  readonly sources: readonly Source[];
};

export const REFERENCE = "docs/reference";
export const COPIES = `${REFERENCE}/copies`;
export const MANIFEST = `${REFERENCE}/sources.json`;

export const loadManifest = async (cwd: string): Promise<Manifest> => {
  const manifest: Manifest = await Bun.file(join(cwd, MANIFEST)).json();
  const seen = new Set<string>();

  for (const source of manifest.sources) {
    if (seen.has(source.package))
      throw new Error(`Duplicate documentation source: ${source.package}`);

    seen.add(source.package);
  }

  return manifest;
};

/** Changes whenever a source is edited, so copies made from an older entry read as stale. */
export const fingerprint = (source: Source): string =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(source)).digest("hex").slice(0, 16);
