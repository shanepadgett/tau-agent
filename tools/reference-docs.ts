import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchDocs, relativePath } from "./reference/fetch.ts";
import { buildIndex, type SourceRecord } from "./reference/index-page.ts";
import { COPIES, fingerprint, loadManifest, REFERENCE } from "./reference/manifest.ts";
import { pinnedVersion, readPins } from "./reference/pins.ts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

const syncReferenceDocs = async (cwd: string): Promise<void> => {
  const manifest = await loadManifest(cwd);
  const pins = await readPins(cwd);
  const reference = join(cwd, REFERENCE);
  const staging = await mkdtemp(join(reference, ".stage-"));
  const records: Record<string, SourceRecord> = {};

  try {
    for (const source of manifest.sources) {
      relativePath(source.package);
      const version = pinnedVersion(source, pins);

      if (version === undefined || !EXACT_VERSION.test(version))
        throw new Error(`Missing exact version for ${source.package}`);

      const destination = join(staging, source.package, version);
      await mkdir(destination, { recursive: true });
      const commits: string[] = [];

      for (const set of source.docs) {
        const commit = await fetchDocs(cwd, source.package, version, set, destination);
        if (commit !== undefined) commits.push(commit);
      }

      records[source.package] = { version, fingerprint: fingerprint(source), commits };
    }

    const generated = await buildIndex(cwd, staging, manifest, pins, records);

    for (const [path, content] of generated) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await Bun.write(join(staging, path), content);
    }

    await Bun.write(join(staging, "versions.json"), `${JSON.stringify(records, null, 2)}\n`);
    await rm(join(cwd, COPIES), { recursive: true, force: true });
    await rename(staging, join(cwd, COPIES));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

await syncReferenceDocs(process.cwd());
