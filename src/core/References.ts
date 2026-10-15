/** The library of reference repositories: read-only git clones in one folder, which a session can attach. The CLI gives the folder through Tau's home; a test gives a temporary one. */

import { basename } from "node:path";
import { Context, type Effect, Schema } from "effect";

/**
 * The folder name of a clone, the branch it has checked out (a short hash on a detached head), and
 * a one-line description: GitHub's, else the first line of the README.
 */
export type Reference = {
  readonly name: string;
  readonly branch: string | undefined;
  readonly description: string | undefined;
};

/** A step of `git clone`, such as `receiving` at 37%. */
export type CloneProgress = {
  readonly phase: "receiving" | "resolving" | "updating";
  readonly percent: number;
};

/** `https://github.com/owner/repo.git` and `git@github.com:owner/repo` both give `repo`; the folder name of a clone. */
export const referenceNameOf = (url: string) =>
  basename(
    url
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, ""),
  )
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** `message` is the line of git's output that says what went wrong. */
export class ReferenceFailed extends Schema.TaggedError<ReferenceFailed>()("ReferenceFailed", {
  reference: Schema.String,
  message: Schema.String,
}) {}

export class References extends Context.Service<
  References,
  {
    /** The folder that holds the clones, such as `~/.tau/references`. */
    readonly folder: string;
    /** The clones by name. It reads folders and `.git/HEAD` files and runs no git. */
    readonly list: Effect.Effect<readonly Reference[]>;
    /**
     * Clones `url` into a folder named after it, and reports progress as git sends it. The folder
     * appears only when the clone is complete.
     */
    readonly clone: (
      url: string,
      onProgress: (progress: CloneProgress) => Effect.Effect<void>,
    ) => Effect.Effect<Reference, ReferenceFailed>;
    /**
     * Fetches GitHub's description for each github.com clone that has none saved, and saves it.
     * It never fails: a clone it cannot reach keeps the description it has.
     */
    readonly fetchDescriptions: Effect.Effect<void>;
    /** Pulls new commits of the current branch, and fails when that is not a fast-forward. */
    readonly update: (name: string) => Effect.Effect<void, ReferenceFailed>;
    /** The branches the remote has and the ones the clone has. */
    readonly branches: (name: string) => Effect.Effect<readonly string[], ReferenceFailed>;
    readonly switchBranch: (
      name: string,
      branch: string,
    ) => Effect.Effect<Reference, ReferenceFailed>;
    readonly remove: (name: string) => Effect.Effect<void, ReferenceFailed>;
    /** Opens the clone in `$VISUAL`, else `$EDITOR`, else `code`, and does not wait for it. */
    readonly open: (name: string) => Effect.Effect<void, ReferenceFailed>;
  }
>()("tau/core/References") {}
