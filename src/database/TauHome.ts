/**
 * Where Tau keeps its files, normally `~/.tau`. The CLI gives the real folder; a test gives a
 * temporary one.
 */

import { Context, Layer } from "effect";

export class TauHome extends Context.Service<TauHome, { readonly directory: string }>()(
  "tau/database/TauHome",
) {
  static readonly at = (directory: string) => Layer.succeed(TauHome, { directory });
}
