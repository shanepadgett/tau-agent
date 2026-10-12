/** Lets non-streaming requests, such as structured output, reach the Codex backend, which only answers with a stream. */

import { Array, Effect, Option, Predicate, Schema } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

const HTTP_OK = 200;

const JsonFields = Schema.Record(Schema.String, Schema.Json);

const RequestBody = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ stream: Schema.optional(Schema.Boolean) }), [JsonFields]),
);

/** Codex sends `phase: "commentary"` messages before the final answer; only the final answer is the reply. */
const OutputItem = Schema.StructWithRest(Schema.Struct({ phase: Schema.optional(Schema.String) }), [
  JsonFields,
]);

const CompletedResponse = Schema.StructWithRest(
  Schema.Struct({ output: Schema.Array(OutputItem) }),
  [JsonFields],
);

const CompletedEvent = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("response.completed"), response: CompletedResponse }),
);

const decodeCompletedEvent = Schema.decodeUnknownOption(CompletedEvent);
const encodeCompletedResponse = Schema.encodeSync(Schema.fromJsonString(CompletedResponse));

/**
 * Sends a non-streaming request as a stream and answers with the completed response, as the
 * non-streaming endpoint would. Streaming requests pass through unchanged.
 */
export const collectCodexStream = (codex: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.makeWith(
    (
      request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError>,
    ) => Effect.flatMap(request, (sent) => sendCollected(codex, sent)),
    (request: HttpClientRequest.HttpClientRequest) => Effect.succeed(request),
  );

const sendCollected = Effect.fn("sendCollected")(function* (
  codex: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
) {
  const body = nonStreamingBody(request);
  if (Option.isNone(body)) return yield* codex.execute(request);

  const streaming = HttpClientRequest.bodyJsonUnsafe(request, { ...body.value, stream: true });
  const response = yield* codex.execute(streaming);
  // Effect's client reads the error from the body itself.
  if (response.status !== HTTP_OK) return response;

  const completed = completedResponse(yield* response.text);

  if (Option.isNone(completed)) {
    return yield* new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request,
        response,
        description: "The Codex stream ended without a response.completed event.",
      }),
    });
  }

  const reply = new Response(encodeCompletedResponse(completed.value), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });

  return HttpClientResponse.fromWeb(request, reply);
});

const nonStreamingBody = (request: HttpClientRequest.HttpClientRequest) => {
  if (!Predicate.isTagged(request.body, "Uint8Array")) return Option.none();

  const body = Schema.decodeUnknownOption(RequestBody)(new TextDecoder().decode(request.body.body));
  return Option.filter(body, (fields) => fields.stream !== true);
};

const completedResponse = (stream: string) => {
  const payloads: string[] = [];

  const parser = Sse.makeParser((event) => {
    if (Predicate.isTagged(event, "Event")) payloads.push(event.data);
  });

  parser.feed(stream);

  return Array.findFirst(payloads, (payload) => decodeCompletedEvent(payload)).pipe(
    Option.map(({ response }) => ({
      ...response,
      output: response.output.filter((item) => item.phase !== "commentary"),
    })),
  );
};
