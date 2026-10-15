/** Keeps the reference repositories as git clones in `~/.tau/references`, and runs the git commands that change them. */

import { join } from "node:path";
import { Effect, FileSystem, Layer, Option } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  type CloneProgress,
  type Reference,
  ReferenceFailed,
  referenceNameOf,
  References,
} from "../core/References.ts";
import { TauHome } from "../database/TauHome.ts";
import { cloneInto } from "./internal/git-clone.ts";
import {
  fillDescription,
  githubDescription,
  readDescription,
  saveDescription,
} from "./internal/reference-description.ts";
import { LOOKUP_TIMEOUT, NETWORK_TIMEOUT, runGit } from "./internal/git-run.ts";

const FOLDER = "references";

/** A clone folder that is not finished starts with this, and `list` skips it. */
const UNFINISHED_PREFIX = ".clone-";

const SHORT_HASH_LENGTH = 7;
const HEAD_BRANCH = /^ref: refs\/heads\/(.+)$/m;

export const referencesLayer = Layer.effect(
  References,
  TauHome.use((home) => makeReferences(join(home.directory, FOLDER))),
);

const failed = (reference: string, message: string) => new ReferenceFailed({ reference, message });

/** The branch from `.git/HEAD`: no git process, so listing many clones stays fast. */
const describeIn = (fileSystem: FileSystem.FileSystem, folder: string) =>
  Effect.fn("References.describe")(function* (name: string) {
    const head = yield* fileSystem
      .readFileString(join(folder, name, ".git", "HEAD"))
      .pipe(Effect.option);

    const branch = Option.map(
      head,
      (text) => HEAD_BRANCH.exec(text)?.[1] ?? text.trim().slice(0, SHORT_HASH_LENGTH),
    );

    const description = yield* readDescription(fileSystem, join(folder, name));
    const reference: Reference = { name, branch: Option.getOrUndefined(branch), description };
    return reference;
  });

const listIn = (
  fileSystem: FileSystem.FileSystem,
  folder: string,
  describe: (name: string) => Effect.Effect<Reference>,
) =>
  Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(folder);
    const shown = names.flatMap((name) => (name.startsWith(".") ? [] : [name]));
    const references = yield* Effect.forEach(shown, describe);
    return references.toSorted((left, right) => left.name.localeCompare(right.name));
  }).pipe(Effect.orElseSucceed((): readonly Reference[] => []));

/** What the git and file work of the layer runs on. */
type Tools = {
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly client: HttpClient.HttpClient;
};

const DESCRIPTION_CONCURRENCY = 4;

const fetchDescriptionsOf = ({ fileSystem, client }: Tools, folder: string) =>
  fileSystem.readDirectory(folder).pipe(
    Effect.flatMap((names) =>
      Effect.forEach(
        names.flatMap((name) => (name.startsWith(".") ? [] : [name])),
        (name) => fillDescription(client, fileSystem, join(folder, name)),
        { concurrency: DESCRIPTION_CONCURRENCY, discard: true },
      ),
    ),
    Effect.ignore,
  );

type Describe = (name: string) => Effect.Effect<Reference>;

/** Clones into an unfinished folder and renames it when git is done, so a failed clone leaves nothing. */
const cloneIn = ({ fileSystem, spawner, client }: Tools, folder: string, describe: Describe) =>
  Effect.fn("References.clone")(function* (
    url: string,
    onProgress: (progress: CloneProgress) => Effect.Effect<void>,
  ) {
    const name = referenceNameOf(url);
    const target = join(folder, name);

    if (name === "") {
      return yield* failed(
        url,
        "Could not find a name in the URL. Use a git URL such as https://github.com/owner/repo.",
      );
    }

    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) {
      return yield* failed(name, `There is already a reference named ${name}. Delete it first.`);
    }

    const unfinished = join(folder, `${UNFINISHED_PREFIX}${name}-${Date.now()}`);

    yield* fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(Effect.mapError((cause) => failed(name, cause.message)));

    yield* cloneInto(name, { folder, url, path: unfinished }, onProgress).pipe(
      Effect.andThen(
        fileSystem
          .rename(unfinished, target)
          .pipe(Effect.mapError((cause) => failed(name, cause.message))),
      ),
      Effect.onError(() =>
        fileSystem.remove(unfinished, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    yield* saveDescription(fileSystem, target, yield* githubDescription(client, url));

    return yield* describe(name);
  });

const makeReferences = Effect.fn("makeReferences")(function* (folder: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  const describe = describeIn(fileSystem, folder);

  const git = (name: string, args: readonly string[], timeout = LOOKUP_TIMEOUT) =>
    runGit(name, join(folder, name), args, timeout).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const switchBranch = Effect.fn("References.switchBranch")(function* (
    name: string,
    branch: string,
  ) {
    const isLocal = (yield* git(name, ["branch", "--list", branch])).trim() !== "";

    if (isLocal) yield* git(name, ["switch", branch]);
    else {
      yield* git(name, ["remote", "set-branches", "--add", "origin", branch]);
      yield* git(name, ["fetch", "--quiet", "--depth=1", "origin", branch], NETWORK_TIMEOUT);
      yield* git(name, ["switch", "--track", "-c", branch, `origin/${branch}`]);
    }

    return yield* describe(name);
  });

  return References.of({
    folder,
    list: listIn(fileSystem, folder, describe),
    fetchDescriptions: fetchDescriptionsOf({ fileSystem, spawner, client }, folder),
    clone: cloneIn({ fileSystem, spawner, client }, folder, describe),
    update: (name) =>
      git(name, ["pull", "--ff-only", "--quiet"], NETWORK_TIMEOUT).pipe(Effect.asVoid),
    branches: branchesOf(git),
    switchBranch,
    remove: (name) =>
      fileSystem
        .remove(join(folder, name), { recursive: true, force: true })
        .pipe(Effect.mapError((cause) => failed(name, cause.message))),
    open: openIn(spawner, folder),
  });
});

type Git = (
  name: string,
  args: readonly string[],
  timeout?: typeof LOOKUP_TIMEOUT,
) => Effect.Effect<string, ReferenceFailed>;

/** Every branch of the clone and of its remote, sorted, each once. */
const branchesOf = (git: Git) =>
  Effect.fn("References.branches")(function* (name: string) {
    const remote = yield* git(name, ["ls-remote", "--heads", "origin"]);
    const local = yield* git(name, ["branch", "--format=%(refname:short)"]);

    const remoteNames = remote.split("\n").flatMap((line) => {
      const ref = line.split("\t")[1]?.replace(/^refs\/heads\//, "");
      return ref === undefined || ref === "" ? [] : [ref];
    });

    const localNames = local
      .split("\n")
      .flatMap((line) => (line.trim() === "" || line.startsWith("(") ? [] : [line.trim()]));

    return [...new Set([...localNames, ...remoteNames])].toSorted();
  });

/** Opens the clone in `$VISUAL`, `$EDITOR` or `code`, and does not wait for it to close. */
const openIn =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], folder: string) =>
  (name: string) => {
    const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "code";

    const command = ChildProcess.make(editor, [join(folder, name)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    return spawner.spawn(command).pipe(
      Effect.flatMap((child) => child.exitCode),
      Effect.scoped,
      Effect.mapError((cause) => failed(name, `Could not start ${editor}: ${cause.message}`)),
      Effect.forkDetach,
      Effect.asVoid,
    );
  };
