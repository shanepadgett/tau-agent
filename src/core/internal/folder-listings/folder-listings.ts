/** Lists each folder a user message tags, one level deep, so the model sees it with the message. */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import type { EntryBody } from "../../../session/Entry.ts";
import { ignoredNames } from "../../../workspace/Repository.ts";
import { tagPaths } from "../../TagText.ts";

/** Past this many names, the listing says how many more there are. */
const MAX_NAMES = 200;
const STAT_CONCURRENCY = 16;

type UserEntry = Extract<EntryBody, { type: "user" }>;

type Listed = { readonly name: string; readonly isFolder: boolean };

/** A user entry, then the listings of the folders its text tags, if it tags any. */
export const withListings = Effect.fn("withListings")(function* (
  directory: string,
  user: UserEntry,
) {
  const listings = yield* Effect.forEach(new Set(tagPaths(user.text)), (path) =>
    folderListing(directory, path),
  );

  const found = listings.flatMap(Option.toArray);

  const bodies: EntryBody[] = [user];
  if (found.length > 0) bodies.push({ type: "folder-listings", text: found.join("\n\n") });

  return bodies;
});

/** A relative tag is in the session folder; a reference tag starts at the home folder. */
const tagFolder = (directory: string, path: string) => {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : join(directory, path);
};

/** The folder's own entries without `.git` and gitignored ones: folders first, then by name. */
const folderListing = Effect.fn("folderListing")(function* (directory: string, path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const folder = tagFolder(directory, path);
  const tagged = yield* Effect.option(fileSystem.stat(folder));
  if (Option.isNone(tagged) || tagged.value.type !== "Directory") return Option.none<string>();

  const ignored = yield* ignoredNames(folder);

  const names = yield* fileSystem
    .readDirectory(folder)
    .pipe(Effect.orElseSucceed((): readonly string[] => []));

  const kept = names.filter((name) => name !== ".git" && !ignored.has(name));

  const listed = yield* Effect.forEach(
    kept,
    (name) =>
      fileSystem.stat(join(folder, name)).pipe(
        Effect.map((entry): Listed => ({ name, isFolder: entry.type === "Directory" })),
        // A broken link still has a name worth showing.
        Effect.orElseSucceed((): Listed => ({ name, isFolder: false })),
      ),
    { concurrency: STAT_CONCURRENCY },
  );

  return Option.some(listingText(path, listed));
});

const byKindThenName = (left: Listed, right: Listed) => {
  if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
};

const listingText = (path: string, listed: readonly Listed[]) => {
  const sorted = listed.toSorted(byKindThenName);

  const lines = sorted
    .slice(0, MAX_NAMES)
    .map(({ name, isFolder }) => (isFolder ? `${name}/` : name));

  const more = sorted.length - MAX_NAMES;
  if (more > 0) lines.push(`… and ${more} more`);
  if (lines.length === 0) lines.push("(empty)");

  return [`Folder @${path}, as the message was sent:`, ...lines].join("\n");
};
