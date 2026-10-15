/**
 * `/commit` in the chat: runs the agent's commit steps in order and keeps the panel's state, one
 * step at a time, from the checks to the push question. Each ending leaves one line in the chat.
 */

import { Effect, Option } from "effect";
import { createSignal } from "solid-js";
import type { OpenSession } from "../../core/Agent.ts";
import type { CommitStart, PlannedCommit, PushTarget } from "../../core/Commits.ts";
import type { ChatAction } from "./chat-state.ts";
import { type ModelRef, refText } from "./model-picker.ts";

/** What the commit panel shows. `review` and `push` wait for an answer. */
export type CommitStep =
  | { readonly type: "checking"; readonly count: number }
  | { readonly type: "planning"; readonly model: string }
  | { readonly type: "review"; readonly plan: readonly PlannedCommit[] }
  | { readonly type: "committing"; readonly index: number; readonly count: number }
  | { readonly type: "push"; readonly target: string; readonly count: number }
  | { readonly type: "pushing"; readonly target: string; readonly count: number };

/** The user's answer to the review (commit the plan) or the push question. */
export type CommitAnswer = "yes" | "no";

export type CommitFlowTarget = {
  readonly opened: OpenSession;
  readonly apply: (action: ChatAction) => void;
  readonly model: () => ModelRef | undefined;
  /** Sends a prompt to the agent, for failed checks. */
  readonly prompt: (text: string) => void;
  /** Runs `effect` in the background, and gives a way to stop it. */
  readonly start: (effect: Effect.Effect<void>) => () => void;
};

/** Ends the flow with one line in the chat. */
class Ended {
  constructor(readonly text: string) {}
}

/** What the steps use: the agent's commit steps, and the panel. */
type Steps = {
  readonly commits: OpenSession["commits"];
  readonly show: (step: CommitStep) => void;
  readonly ask: Effect.Effect<CommitAnswer>;
  readonly target: CommitFlowTarget;
};

const end = (text: string) => Effect.fail(new Ended(text));
const endWithError = (error: { readonly message: string }) => end(error.message);

export const commitFlow = (target: CommitFlowTarget) => {
  const [step, setStep] = createSignal<CommitStep | undefined>();
  const [answer, setAnswer] = createSignal<((answer: CommitAnswer) => void) | undefined>();
  let stop: (() => void) | undefined;

  const steps: Steps = {
    commits: target.opened.commits,
    show: setStep,
    ask: Effect.callback<CommitAnswer>((resume) => {
      setAnswer(() => (given: CommitAnswer) => {
        setAnswer(undefined);
        resume(Effect.succeed(given));
      });
    }),
    target,
  };

  const finish = (ended: Ended) => {
    setStep(undefined);
    setAnswer(undefined);
    stop = undefined;
    target.apply({ type: "notice", text: ended.text });
  };

  return {
    step,
    /** Starts `/commit`, with the text after it as the user's instruction. */
    run: (instruction: string) => {
      if (step() !== undefined) return;

      const flow = commitAll(steps, instruction).pipe(
        Effect.catch((ended) =>
          Effect.sync(() => {
            finish(ended);
          }),
        ),
      );

      stop = target.start(flow);
    },
    /** Answers the review or the push question. */
    reply: (given: CommitAnswer) => answer()?.(given),
    /** Escape: no to the question, or stops checks and planning. Committing cannot stop. */
    cancel: () => {
      const reply = answer();
      const type = step()?.type;

      if (reply !== undefined) reply("no");
      else if (type === "checking" || type === "planning") {
        stop?.();
        finish(new Ended("Commit cancelled."));
      }
    },
  };
};

export type CommitFlow = ReturnType<typeof commitFlow>;

/** Every step; it always fails with the line that ends it. */
const commitAll = Effect.fn("commitAll")(function* (steps: Steps, instruction: string) {
  const { commits, show, ask, target } = steps;
  const found = yield* commits.start.pipe(Effect.catch(endWithError));
  if (Option.isNone(found)) return yield* end("Not in a git repository.");
  const start = found.value;
  if (start.files.length === 0) return yield* end("Nothing to commit.");

  show({
    type: "checking",
    count: yield* commits.checkCount(start).pipe(Effect.catch(endWithError)),
  });

  yield* checked(steps, start);
  const chatModel = target.model();
  if (chatModel === undefined) return yield* end("No model is set. Pick one with /model.");
  const model = yield* commits.planModel(chatModel).pipe(Effect.catch(endWithError));
  show({ type: "planning", model: refText(model) });

  const plan = yield* commits
    .plan(start, model, instruction)
    .pipe(Effect.catch((error) => end(`Could not plan commits: ${error.message}`)));

  show({ type: "review", plan });
  if ((yield* ask) === "no") return yield* end("Commit cancelled.");
  return yield* committed(steps, start, plan);
});

/** Runs the checks, and ends the flow unless they pass. Failures go to the agent. */
const checked = Effect.fn("checked")(function* (steps: Steps, start: CommitStart) {
  const checks = yield* steps.commits.check(start).pipe(Effect.catch(endWithError));

  if (checks.type === "changed")
    return yield* end("A check changed files. Review the changes and run /commit again.");

  if (checks.type === "failed") {
    steps.target.prompt(checks.prompt);
    return yield* end(`Commit checks failed: ${checks.names.join(", ")}. Nothing was committed.`);
  }
});

const committed = Effect.fn("committed")(function* (
  steps: Steps,
  start: CommitStart,
  plan: readonly PlannedCommit[],
) {
  const count = plan.length;

  const hashes = yield* steps.commits
    .commit(start, plan, (index) => {
      steps.show({ type: "committing", index, count });
    })
    .pipe(
      Effect.catchTag("CommitFailed", (error) =>
        end(`${committedText(error.hashes)}, then failed: ${error.message}`),
      ),
    );

  const done = committedText(hashes);
  const pushTo = yield* wantedPush(steps, start, hashes.length);
  if (Option.isNone(pushTo)) return yield* end(`${done}.`);

  steps.show({ type: "pushing", target: pushTo.value.name, count: hashes.length });

  yield* steps.commits
    .push(start, pushTo.value)
    .pipe(Effect.catch((error) => end(`${done}; push failed: ${error.message}`)));

  return yield* end(`${done} and pushed to ${pushTo.value.name}.`);
});

/** Where to push, or none when the settings or the user say not to. */
const wantedPush = Effect.fn("wantedPush")(function* (
  steps: Steps,
  start: CommitStart,
  count: number,
) {
  const { push } = steps.commits.settings;
  if (push === false) return Option.none<PushTarget>();
  const pushTo = yield* steps.commits.pushTarget(start).pipe(Effect.catch(endWithError));
  if (Option.isNone(pushTo) || push === true) return pushTo;
  steps.show({ type: "push", target: pushTo.value.name, count });
  return (yield* steps.ask) === "yes" ? pushTo : Option.none<PushTarget>();
});

const committedText = (hashes: readonly string[]) =>
  hashes.length === 0 ? "Committed nothing" : `Committed ${hashes.length} (${hashes.join(", ")})`;
