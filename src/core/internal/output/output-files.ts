/** Allocates session output files and renders bounded previews with links to their retained text. */

import { basename, dirname, join } from "node:path";
import { Context, type Crypto, Effect, FileSystem, Schema } from "effect";
import { captureOutput, type CapturedOutput } from "../../../proc/Output.ts";
import type { SessionId } from "../../../session/Entry.ts";
import type { OutputFolder } from "../../OutputFolder.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const OTHER_PERMISSIONS = 0o077;

class OutputUnavailable extends Schema.TaggedError<OutputUnavailable>()("OutputUnavailable", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Cannot save output in ${this.path}. Check the folder's permissions and free disk space.`;
  }
}

export class OutputFiles extends Context.Service<
  OutputFiles,
  {
    readonly next: (label: OutputLabel) => Effect.Effect<string, OutputUnavailable>;
  }
>()("tau/core/OutputFiles") {}

export const makeOutputFiles = (
  folder: OutputFolder["Service"],
  session: SessionId,
  fileSystem: FileSystem.FileSystem,
  crypto: Crypto.Crypto,
): OutputFiles["Service"] => ({
  next: Effect.fn("OutputFiles.next")(
    function* (label: OutputLabel) {
      const parent = yield* fileSystem.realPath(dirname(folder.directory));
      const root = join(parent, basename(folder.directory));
      const directory = join(root, encodeURIComponent(session));
      yield* privateDirectory(fileSystem, root);
      yield* privateDirectory(fileSystem, directory);
      return join(directory, `${label}-${yield* crypto.randomUUIDv4()}.log`);
    },
    Effect.mapError((cause) => new OutputUnavailable({ path: folder.directory, cause })),
  ),
});

const privateDirectory = Effect.fn("privateDirectory")(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
) {
  yield* fileSystem.makeDirectory(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const canonical = yield* fileSystem.realPath(path);
  const status = yield* fileSystem.stat(path);

  const isPrivate =
    canonical === path && status.type === "Directory" && (status.mode & OTHER_PERMISSIONS) === 0;

  if (!isPrivate)
    return yield* new OutputUnavailable({
      path,
      cause: new Error("Not a private, unlinked directory"),
    });
});

type RenderedOutput = { readonly text: string; readonly output: string | undefined };
type OutputExtent = "whole" | "retained";
type OutputLabel = "sh" | "run" | "check" | "checks";

export const renderOutput = (captured: CapturedOutput, extent: OutputExtent): RenderedOutput => {
  if (captured.type === "whole") return { text: captured.text, output: undefined };
  const location = extent === "whole" ? "Full output" : "Retained output";
  const note = `[Output shortened. ${location} saved at ${captured.path}. Search that file or print less.]`;
  return { text: `${captured.start}\n${note}\n${captured.end}`, output: captured.path };
};

export const saveOutput = Effect.fn("saveOutput")(function* (
  parts: Iterable<string>,
  label: OutputLabel,
  extent: OutputExtent,
) {
  const files = yield* OutputFiles;
  const path = yield* files.next(label);

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const capture = yield* captureOutput(path);
      for (const part of parts) yield* capture.accept(new TextEncoder().encode(part));
      return renderOutput(yield* capture.result, extent);
    }),
  ).pipe(Effect.mapError((cause) => new OutputUnavailable({ path, cause })));
});
