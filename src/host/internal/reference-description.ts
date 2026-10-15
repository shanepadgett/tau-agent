/** The one-line description of a reference: GitHub's, saved at clone time, else the README's first line. */

import { join } from "node:path";
import { Duration, Effect, FileSystem, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const SAVED = "tau-description";
const README_NAMES = ["README.md", "README", "readme.md", "README.markdown"];
const GITHUB_TIMEOUT_SECONDS = 5;
const GITHUB_TIMEOUT = Duration.seconds(GITHUB_TIMEOUT_SECONDS);
const GITHUB_URL = /github\.com[/:](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i;

/** A line that starts a title, badge, tag, list, table or code block says little about the project. */
const NOT_PROSE = /^[#!<[|>`=\-*_~]/;

const Repository = Schema.Struct({ description: Schema.NullOr(Schema.String) });

/** The first line of prose in a README, with Markdown links and emphasis reduced to their text. */
const readmeDescription = (readme: string): string | undefined => {
  const line = readme
    .split("\n")
    .map((each) => each.trim())
    .find((each) => each !== "" && !NOT_PROSE.test(each));

  return line
    ?.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
};

const firstReadme = (fileSystem: FileSystem.FileSystem, directory: string) =>
  Effect.firstSuccessOf(
    README_NAMES.map((name) =>
      fileSystem.readFileString(join(directory, name)).pipe(Effect.map(readmeDescription)),
    ),
  ).pipe(Effect.option, Effect.map(Option.getOrUndefined));

/** The saved GitHub description, else the README's, else none. */
export const readDescription = Effect.fn("readDescription")(function* (
  fileSystem: FileSystem.FileSystem,
  directory: string,
) {
  const saved = yield* fileSystem.readFileString(join(directory, ".git", SAVED)).pipe(
    Effect.map((text) => text.trim()),
    Effect.option,
  );

  return Option.isSome(saved) && saved.value !== ""
    ? saved.value
    : yield* firstReadme(fileSystem, directory);
});

/** GitHub's description of the repository `url` names, or none for another host or on any failure. */
export const githubDescription = (client: HttpClient.HttpClient, url: string) => {
  const groups = GITHUB_URL.exec(url.trim())?.groups;
  if (groups === undefined) return Effect.sync((): string | undefined => undefined);

  return HttpClientRequest.get(
    `https://api.github.com/repos/${groups["owner"]}/${groups["repo"]}`,
  ).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    client.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Repository)),
    Effect.map(({ description }) => description?.trim() || undefined),
    Effect.timeout(GITHUB_TIMEOUT),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
};

/** Saves `description` in the clone's `.git` folder. A failure to save is ignored. */
export const saveDescription = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
  description: string | undefined,
) =>
  description === undefined
    ? Effect.void
    : fileSystem.writeFileString(join(directory, ".git", SAVED), description).pipe(Effect.ignore);

const ORIGIN_URL = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/;

/** Fetches and saves GitHub's description for a clone that has none saved yet. It needs no git process. */
export const fillDescription = Effect.fn("fillDescription")(function* (
  client: HttpClient.HttpClient,
  fileSystem: FileSystem.FileSystem,
  directory: string,
) {
  const saved = yield* fileSystem.exists(join(directory, ".git", SAVED)).pipe(Effect.option);
  if (Option.contains(saved, true)) return;

  const config = yield* fileSystem
    .readFileString(join(directory, ".git", "config"))
    .pipe(Effect.option);

  const url = Option.flatMap(config, (text) => Option.fromNullishOr(ORIGIN_URL.exec(text)?.[1]));
  if (Option.isNone(url)) return;

  yield* saveDescription(fileSystem, directory, yield* githubDescription(client, url.value));
});
