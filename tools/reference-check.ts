import { stat } from "node:fs/promises";
import { join } from "node:path";
import { buildIndex, type Records } from "./reference/index-page.ts";
import { COPIES, fingerprint, loadManifest, MANIFEST, type Source } from "./reference/manifest.ts";
import { pinnedNames, pinnedVersion, readPins, type Pins } from "./reference/pins.ts";

const SYNC = "run `mise run docs`";

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const coverageProblems = (
  sources: readonly Source[],
  ignore: readonly string[],
  pins: Pins,
): string[] => {
  const names = pinnedNames(pins);
  const covered = new Set(sources.map((source) => source.package));
  const problems: string[] = [];

  for (const name of names) {
    if (!covered.has(name) && !ignore.includes(name))
      problems.push(`No reference for ${name}: add a source to ${MANIFEST}, or list it in ignore`);
  }

  for (const name of ignore) {
    if (!names.includes(name))
      problems.push(`${MANIFEST} ignores ${name}, which is not a dependency or tool`);
  }

  for (const source of sources) {
    if (pinnedVersion(source, pins) === undefined)
      problems.push(`${MANIFEST} has a source for ${source.package}, which is not pinned`);
  }

  return problems;
};

const sourceProblems = async (
  cwd: string,
  source: Source,
  version: string,
  records: Records,
): Promise<string[]> => {
  const record = records[source.package];
  const name = source.package;

  if (record === undefined) return [`No copy of the docs for ${name}; ${SYNC}`];

  if (record.version !== version)
    return [`The docs for ${name} are ${record.version} but ${version} is pinned; ${SYNC}`];

  const problems: string[] = [];

  if (record.fingerprint !== fingerprint(source))
    problems.push(`The source for ${name} changed after its docs were copied; ${SYNC}`);

  if (!(await exists(join(cwd, COPIES, name, version))))
    problems.push(`The docs folder for ${name} ${version} is missing; ${SYNC}`);

  for (const pointer of source.api) {
    if (!(await exists(join(cwd, "node_modules", pointer.path))))
      problems.push(`${name}: API path node_modules/${pointer.path} does not exist`);
  }

  return problems;
};

const indexProblems = async (
  cwd: string,
  pins: Pins,
  sources: readonly Source[],
  ignore: readonly string[],
  records: Records,
): Promise<string[]> => {
  const copies = join(cwd, COPIES);
  const generated = await buildIndex(cwd, copies, { ignore, sources }, pins, records);
  const problems: string[] = [];

  for (const [path, content] of generated) {
    const file = Bun.file(join(copies, path));

    if (!(await file.exists()) || (await file.text()) !== content)
      problems.push(`${COPIES}/${path} is out of date; ${SYNC}`);
  }

  return problems;
};

const findProblems = async (cwd: string): Promise<string[]> => {
  const { ignore, sources } = await loadManifest(cwd);
  const pins = await readPins(cwd);
  const problems = coverageProblems(sources, ignore, pins);
  const recordsFile = Bun.file(join(cwd, COPIES, "versions.json"));

  if (!(await recordsFile.exists())) return [...problems, `${COPIES} is missing; ${SYNC}`];
  const records: Records = await recordsFile.json();

  for (const source of sources) {
    const version = pinnedVersion(source, pins);

    if (version !== undefined)
      problems.push(...(await sourceProblems(cwd, source, version, records)));
  }

  for (const name of Object.keys(records)) {
    if (!sources.some((source) => source.package === name))
      problems.push(`${COPIES} has docs for ${name}, which is not in ${MANIFEST}; ${SYNC}`);
  }

  if (problems.length > 0) return problems;
  return indexProblems(cwd, pins, sources, ignore, records);
};

const problems = await findProblems(process.cwd());
for (const problem of problems) console.log(problem);
process.exit(problems.length === 0 ? 0 : 1);
