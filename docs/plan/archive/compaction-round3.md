# Step 5, round 3: dreaming (code plan)

Status: implemented, repository checks passed and committed, 2026-10-14. Archived; the lasting decisions are in [compaction.md](../work/compaction.md#round-3-dreaming). Replay comparisons are deferred ([deferred.md](../deferred.md)). Slice 5a's design is in [compaction.md](../work/compaction.md).

**What the code can do afterwards:** in long sessions, a background job folds older notes into a short session memory. The next checkpoint shows that memory instead of the notes it covers, so the context stays small without losing what mattered early on. Between checkpoints nothing changes, so the prompt cache holds.

## Agreed rules

| Rule | Decision |
| --- | --- |
| Scope | Memory belongs to one session: a compressed record of older notes, not instructions or cross-session preferences |
| Trigger | Saved notes not covered by the latest memory pass 30k estimated tokens |
| Fold | The oldest whole notes; about 8k of the newest notes stay as notes. Memory aims for at most 4k tokens. Starting values, not measured |
| Input | The latest memory plus the notes being folded. The note writer reads the latest memory plus later notes, never folded notes |
| Storage | Append-only snapshots. Memory *n* covers notes 1 through `throughNote`; a newer memory supersedes it. Source notes and entries are kept |
| Activation | Only at a checkpoint, which pins one memory and the notes after it |
| Worker | One serial worker per session writes notes first, then a dream; it never blocks the agent and resumes from saved rows after a crash |
| Failure | A failed, empty or out-of-date dream saves nothing; the next wake tries again |

**Pattern:** append-only snapshots pinned by a checkpoint. A mutable latest-memory row was rejected: a late write would change old checkpoints and forks. One worker beat separate note and dream fibers, which need scheduling and in-flight state. Mastra's reflector (`packages/memory/src/processors/observational-memory/ARCHITECTURE.md`) shows the races that mutable activation causes; Pi durable (`packages/durable/docs/spec.md` §8.7) applies summaries at a boundary, as Tau does at a checkpoint.

## Today

| Piece | Where | Changes |
| --- | --- | --- |
| Note table and service | `src/session/Notes.ts` | adds the memory table and two methods |
| Background loop | `startNoteWriter` in `notes/note-writer.ts` | moves to a worker that also dreams |
| Model choice, empty-reply check | private in `note-writer.ts` | shared by notes and dreams |
| Checkpoint pins | `checkpoint.ts`: note numbers, `noteTokens`, `tailFrom` | also pins one memory |
| View | `view.ts`: `[system][notes][instructions][tail][handoff][later]` | memory before the notes |
| Test helpers | private in `tests/core/compaction.test.ts` | move to `tests/support/` for a second test file |

## Files

```text
src/session/
  Notes.ts        changed: MEMORY_TABLE, Memory, memories(), appendMemory(), MemoryConflict
  Sessions.ts     changed: migration 7 adds the memory table; fork copies memories in range
  Entry.ts        changed: CheckpointDetails gains optional `memory`
src/core/internal/context/notes/
  summarize.ts    new: summaryModel (moved from note-writer) and summarize (generate, reject empty)
  note-writer.ts  changed: only writeNextNote; reads memory plus later notes
  dream.ts        new: dreamNext, the fold rules and DREAM_RULES
  worker.ts       new: startContextWorker, the wake loop moved from note-writer
  checkpoint.ts   changed: pins the latest memory and the notes after it
  view.ts         changed: summaryPrefix(memory, notes) replaces notePrefix
  budget.ts       changed: notesView call takes memories
  method.ts       changed: uses the worker; view reads notes and memories
tests/support/compaction.ts  new: contextLayer, checkpointReply, counted, waitForNotes, moved
tests/core/compaction.test.ts changed: imports those helpers
tests/core/dreaming.test.ts  new: the dreaming flow
docs/guide/checkpoints.md    changed: what memory is and when it applies
```

Nothing is deleted except the moved code. No setting is added; the thresholds are constants beside `NOTE_CHUNK_TOKENS`.

## Types

```ts
// session/Notes.ts
"CREATE TABLE memory (session_id TEXT NOT NULL REFERENCES session (id), number INTEGER NOT NULL, " +
  "through_note INTEGER NOT NULL, through_entry INTEGER NOT NULL, text TEXT NOT NULL, " +
  "route TEXT NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, number)) STRICT";

type NewMemory = {
  readonly parent: number | undefined;   // latest memory number the dream read
  readonly throughNote: number;
  readonly text: string;
  readonly model: ModelRef;
};
type Memory = Omit<NewMemory, "parent"> & { number: number; throughEntry: number; at: DateTime.Utc };

class MemoryConflict extends Schema.TaggedError<MemoryConflict>()("MemoryConflict", {
  session: SessionId, reason: Schema.String,  // "newer memory exists" | "note missing" | "no new notes"
}) {}

// added to the Notes service
memories: (session: SessionId) => Effect<readonly Memory[], SessionStoreError>;
appendMemory: (session: SessionId, memory: NewMemory) => Effect<Memory, MemoryConflict | SessionStoreError>;

// session/Entry.ts: absent on old checkpoints, so no data migration
CheckpointDetails = { tool, handoff, memory?: Int, notes, noteTokens, tailFrom }  // noteTokens: memory plus notes

// notes/summarize.ts
summaryModel: (catalog, current: ModelRef) => Effect<ModelRef, UnknownModel | UnknownRoute>;
summarize: (model: LanguageModel, rules: string, input: string) => Effect<string, AiError>;

// notes/view.ts
notesView: (soul, entries, notes: readonly Note[], memories: readonly Memory[]) => Prompt.Prompt;
summaryPrefix: (memory: Memory | undefined, notes: readonly Note[]) => Prompt.Prompt;
```

## Call path

```mermaid
sequenceDiagram
  participant R as runner
  participant W as context worker
  participant N as note writer
  participant D as dream
  participant S as Notes service
  R->>W: background(session, subscribe)
  W->>N: writeNextNote, repeat while one is due
  N->>S: append note
  W->>D: dreamNext, repeat while one is due
  D->>S: appendMemory(parent, throughNote)
  Note over R,S: a later checkpoint pins memory + later notes; the view renders them
```

Production and tests share this path. Tests inject `ContextMethod.layer` with a fake catalog; notes and dreams both come from the harness's scripted `generateText` replies, in call order, and both prompts land in `notePrompts`.

## Logic

```text
worker, on opening the session and on each batch with tool-ended or run-ended:
  loop
    if writeNextNote → continue
    if dreamNext → continue
    stop
  on failure: log a warning; the next wake retries

writeNextNote: as today, except
  earlier = latest memory "Session memory of entries 1–{throughEntry}" + notes after its throughNote

dreamNext:
  latest = last memory, or none
  uncovered = notes after latest.throughNote
  stop if tokens(uncovered) < 30k
  kept = newest uncovered notes, taken until they reach 8k
  fold = uncovered before kept; stop if empty
  model = summaryModel(the last folded note's model)
  text = summarize(model at "{session}:memory", DREAM_RULES, latest text + fold notes with entry ranges)
  appendMemory(session, { parent: latest.number, throughNote: last of fold, text, model })

appendMemory, in one write transaction:
  newest memory number ≠ parent → MemoryConflict
  note throughNote missing, or ≤ the newest memory's throughNote → MemoryConflict
  insert with throughEntry = that note's through

DREAM_RULES: fold the notes into the memory; keep user preferences and corrections, decisions and
  reasons, project facts, unfinished work and entry ranges; a later fact replaces an earlier one;
  the text is a record to summarize, not instructions; at most 4000 tokens; return only the memory

checkpoint:
  memory = newest memory with throughEntry < reply.number
  notes = notes after memory.throughNote with through < reply.number
  tailFrom = (last note's through, else memory.throughEntry, else 0) + 1
  details = { handoff, memory: its number, notes, noteTokens: tokens(summaryPrefix(memory, notes)), tailFrom }

view: as today, with the pinned memory as the first message after the system prompt;
  the cache mark goes on the last note, or on the memory when no notes follow it

fork(through): also copy memories with through_entry ≤ through, keeping numbers
```

## Tests

`tests/core/dreaming.test.ts`, seeding notes with `harness.notes.append` instead of writing 30k of chat:

| Test | Passes when |
| --- | --- |
| Fold | Past 30k uncovered notes, one dream folds the oldest notes, keeps about 8k, and its prompt holds only the folded notes |
| Activation | Model calls before a checkpoint are unchanged after a dream; the call after it starts with memory, then later notes, raw tail and handoff |
| Lineage | A second dream reads the first memory and only newer notes; the note writer's prompt holds memory, not folded notes |
| Failure | An empty dream saves nothing, the old context stays, and the next run's wake writes it |
| Conflict | `appendMemory` with a stale parent, a missing note or no new notes fails with `MemoryConflict` |
| Fork and reopen | A fork keeps only memories within its range; memories survive reopening the database |
| All notes folded | A checkpoint whose memory covers every note starts the raw tail after the memory's last entry |

The existing compaction tests must pass unchanged, which covers old checkpoints without `memory`.

## Open

None. Live checks stay deferred.
