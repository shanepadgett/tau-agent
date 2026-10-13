/**
 * Counts how often the model loads each skill, in `~/.tau/sessions.db`, so the skill list shows
 * the skills the user needs most.
 */

import { Context, DateTime, Duration, Effect, Schema } from "effect";
import type { Database } from "../database/Database.ts";

/** A use loses half its weight in this many days, so recent uses count more. */
const HALF_LIFE_DAYS = 14;
const HALF_LIFE = Duration.days(HALF_LIFE_DAYS);
/** A use in the same session directory counts this many times. */
const SAME_DIRECTORY_WEIGHT = 2;
/** What is left of a use's weight after one half-life. */
const HALF = 0.5;
/** Only the latest uses count, so the ranking stays fast. */
const MAX_USES = 1000;

export const SKILL_USE_TABLE =
  "CREATE TABLE skill_use (skill TEXT NOT NULL, directory TEXT NOT NULL, at INTEGER NOT NULL) STRICT";

const UseRow = Schema.Struct({
  skill: Schema.String,
  directory: Schema.String,
  at: Schema.DateTimeUtcFromMillis,
});

export class SkillUses extends Context.Service<
  SkillUses,
  {
    /** A failure to save is logged: a lost use only changes the order of the skill list. */
    readonly record: (skill: string, directory: string) => Effect.Effect<void>;

    /**
     * A score for each skill used before, higher for more uses. Uses in `directory` count double,
     * and a use loses half its weight every 14 days. A failure to read gives no scores, logged.
     */
    readonly ranking: (directory: string) => Effect.Effect<ReadonlyMap<string, number>>;
  }
>()("tau/session/SkillUses") {}

/** Skill uses in the open sessions database. */
export const makeSkillUses = (database: Database) => {
  const record = (skill: string, directory: string) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        database.writeTransaction((transaction) =>
          transaction.run("INSERT INTO skill_use (skill, directory, at) VALUES (?, ?, ?)", [
            skill,
            directory,
            DateTime.toEpochMillis(now),
          ]),
        ),
      ),
      Effect.catch((error) => Effect.logWarning("Could not save a skill use.", error)),
    );

  const ranking = Effect.fn("SkillUses.ranking")(function* (directory: string) {
    const now = yield* DateTime.now;

    const uses = yield* database
      .query(
        "SELECT skill, directory, at FROM skill_use ORDER BY at DESC LIMIT ?",
        [MAX_USES],
        UseRow,
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not read the skill uses.", error).pipe(Effect.as([])),
        ),
      );

    const scores = new Map<string, number>();

    for (const use of uses) {
      const age = DateTime.distance(use.at, now);
      const weight = use.directory === directory ? SAME_DIRECTORY_WEIGHT : 1;
      const score = weight * HALF ** (Duration.toMillis(age) / Duration.toMillis(HALF_LIFE));
      scores.set(use.skill, (scores.get(use.skill) ?? 0) + score);
    }

    return scores;
  });

  return SkillUses.of({ record, ranking });
};
