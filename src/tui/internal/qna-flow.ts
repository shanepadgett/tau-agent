/**
 * `/qna` in the chat: asks the model for its open questions, opens the panel when it puts them, and
 * sends the answers back as the next prompt.
 */

import { createSignal } from "solid-js";
import type { AgentEvent, RunOptions } from "../../core/Client.ts";
import type { ChatAction } from "./chat-state.ts";
import { type QnaState, qnaState, send } from "./qna-state.ts";

export type QnaFlowTarget = {
  readonly apply: (action: ChatAction) => void;
  /** Sends a prompt; `askQuestions` gives the model the `ask_question` tool for its run. */
  readonly prompt: (text: string, tools: Pick<RunOptions, "askQuestions">) => void;
};

const REQUEST =
  "[qna] Ask me, with the ask_question tool, the questions you still need answered. Ask them again if you asked them already.";

export const qnaFlow = (target: QnaFlowTarget) => {
  const [state, setState] = createSignal<QnaState | undefined>();
  let isWaiting = false;

  const close = () => {
    setState(undefined);
  };

  return {
    /** The panel's state, or undefined while no panel shows. */
    state,
    /** Starts `/qna`, with the text after it as context for the questions. */
    start: (context: string) => {
      isWaiting = true;
      target.prompt(context === "" ? REQUEST : `${REQUEST}\n\n${context}`, { askQuestions: true });
    },
    /** Opens the panel when the run that `/qna` started ends with questions. */
    offer: (event: AgentEvent) => {
      if (event.type !== "run-ended" || !isWaiting) return;
      isWaiting = false;

      if (event.reason === "questions-asked") setState(qnaState(event.questions));
      else if (event.reason === "answered")
        target.apply({ type: "notice", text: "The model had no questions to ask." });
    },
    /** Changes the panel's state, such as moving the cursor. */
    update: (change: (current: QnaState) => QnaState) => {
      setState((current) => (current === undefined ? undefined : change(current)));
    },
    /** Sends the answers, or shows the first question that has none. */
    send: () => {
      const current = state();
      if (current === undefined) return;
      const sent = send(current);

      if (sent.type === "incomplete") {
        setState(sent.state);
        return;
      }

      close();
      target.prompt(sent.text, { askQuestions: false });
    },
    cancel: () => {
      close();
      target.apply({ type: "notice", text: "/qna cancelled. Nothing was sent." });
    },
  };
};

export type QnaFlow = ReturnType<typeof qnaFlow>;
