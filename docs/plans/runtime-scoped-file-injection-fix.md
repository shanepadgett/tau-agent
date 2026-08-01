# Runtime-Scoped File Injection Fix

## Problem

Explore registers file-injection resources in a module-local `host`. Pi loads each extension through a separate Jiti module graph, so Context and Continuity see different copies of that variable. Full reads still work, but outline and `auto` injection cannot reach Explore's host.

Context also reports success without checking per-file results. Continuity can complete a checkpoint after active-file preparation fails, allowing its context projection to retire useful history without the requested replacement files.

## Constraints

- `/context` must attach its brief and file rows before returning control to the editor. It must not wait for another user prompt.
- File-injection resources must remain scoped to one Pi runtime. Do not use a process-global singleton.
- Successful injections must preserve existing model-visible content, ordering, batch IDs, and display behavior.
- A failed checkpoint file must prevent the checkpoint transition and preserve prior context.
- Internal provider transport must not add model-visible messages or change provider request fields.

## Implementation

### 1. Add a runtime-scoped preparation provider

- Add an internal Tau event for file-injection preparation.
- Have Explore register a provider closure through `pi.events` for each active session.
- Make the listener synchronously accept a preparation promise so request dispatch has no timing race.
- Remove the module-local host and pass Explore's host explicitly to internal preparation functions.
- Change `prepareFileInjection` to accept a Pi event API. Keep `injectFiles` as the prepare-and-send convenience API.
- If no provider exists, keep full and ranged reads available while returning normal failed rows for modes that require Explore.

### 2. Preserve caller-owned message behavior

- Apply Continuity row visibility in the calling extension after provider preparation, not inside Explore's module graph.
- Keep caller-controlled send order. Provider prepares messages but never appends them to a session.
- Update Handoff to prepare its full-read messages before session replacement and pass the prepared data into setup.

### 3. Make Context and Continuity handle results correctly

- Have `/context` prepare first, then send its brief and file rows in the existing order.
- Report successful and failed file counts accurately. Preserve the existing success-path brief exactly.
- Have `checkpoint` prepare and validate every active file before sending any file row or continuation marker.
- Throw on the first checkpoint file failure. Without successful checkpoint details, Continuity's context projection leaves prior history intact.

### 4. Add regression coverage

- Cover provider registration, synchronous acceptance, session shutdown, and provider-unavailable behavior through a shared Pi event bus.
- Cover successful outline preparation through the provider and full-read fallback without one.
- Cover atomic checkpoint failure: no file rows, continuation marker, or successful checkpoint result.
- Cover successful checkpoint file ordering and hidden-row display behavior.
- Exercise final post-`context` messages across consecutive requests. Assert unchanged content keeps the same serialized fingerprint and failed preparation preserves the prior stable prefix.

## Verification

- Run focused tests while developing where useful.
- Let repository TypeScript and Markdown checks run through the harness.
- Reproduce `/context` with the Continuity catalog after `/reload`; all five outline rows should succeed before the next user prompt.
