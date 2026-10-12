// Pure Anthropic Messages stream reducer. Both versions use it unchanged; the
// spike compares only the plumbing around it (HTTP, SSE framing, cancellation).

export type SseEvent = { readonly event?: string | undefined; readonly data: string };

export type StreamEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "done"; readonly stop: string; readonly usage: Usage }
	| { readonly type: "error"; readonly message: string };

type Usage = { readonly input: number; readonly output: number };
type State = { readonly usage: Usage; readonly stop?: string; readonly finished: boolean };

export const initial = (): State => ({ usage: { input: 0, output: 0 }, finished: false });

export function step(state: State, sse: SseEvent): readonly [State, ReadonlyArray<StreamEvent>] {
	if (sse.event === "ping") return [state, []];
	const data = JSON.parse(sse.data);
	switch (data.type) {
		case "message_start":
			return [{ ...state, usage: { ...state.usage, input: data.message.usage.input_tokens } }, []];
		case "content_block_delta":
			return data.delta.type === "text_delta" ? [state, [{ type: "text", text: data.delta.text }]] : [state, []];
		case "message_delta":
			return [{ ...state, stop: data.delta.stop_reason, usage: { ...state.usage, output: data.usage.output_tokens } }, []];
		case "message_stop":
			return [{ ...state, finished: true }, [{ type: "done", stop: state.stop ?? "unknown", usage: state.usage }]];
		case "error":
			return [{ ...state, finished: true }, [{ type: "error", message: data.error.message }]];
		default:
			return [state, []];
	}
}

export const end = (state: State): ReadonlyArray<StreamEvent> =>
	state.finished ? [] : [{ type: "error", message: "stream ended before message_stop" }];
