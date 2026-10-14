/** A failure to read or write the session database, including its background notes. */

import { Schema } from "effect";

export class SessionStoreError extends Schema.TaggedError<SessionStoreError>()(
  "SessionStoreError",
  { path: Schema.String, cause: Schema.Defect() },
) {}
