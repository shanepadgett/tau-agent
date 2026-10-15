/**
 * Sends non-streaming requests, such as structured output, to the ChatGPT plan providers as streams.
 * These providers reply only with a stream.
 */

import { Array, Effect, Option, Predicate, Schema } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

const HTTP_OK = 200;

const JsonFields = Schema.Record(Schema.String, Schema.Json);

const RequestBody = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ stream: Schema.optional(Schema.Boolean) }), [JsonFields]),
);

/** Models may send `phase: "commentary"` messages before the final answer; only the final answer is the reply. */
const OutputItem = Schema.StructWithRest(Schema.Struct({ phase: Schema.optional(Schema.String) }), [
  JsonFields,
]);

const OutputItemDoneEvent = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("response.output_item.done"),
    output_index: Schema.Number,
    item: OutputItem,
  }),
);

const CompletedEvent = Schema.fromJsonString(
  Schema.Struct({ type: Schema.Literal("response.completed"), response: JsonFields }),
);

const decodeOutputItemDone = Schema.decodeUnknownOption(OutputItemDoneEvent);
const decodeCompletedEvent = Schema.decodeUnknownOption(CompletedEvent);
const encodeCompletedResponse = Schema.encodeSync(Schema.fromJsonString(JsonFields));

/**
 * Sends a non-streaming request as a stream and answers with the completed response, as the
 * non-streaming endpoint would. Streaming requests pass through unchanged.
 */
export const collectResponseStream = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.makeWith(
    (
      request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError>,
    ) => Effect.flatMap(request, (sent) => sendCollected(client, sent)),
    (request: HttpClientRequest.HttpClientRequest) => Effect.succeed(request),
  );

const sendCollected = Effect.fn("sendCollected")(function* (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
) {
  const body = nonStreamingBody(request);
  if (Option.isNone(body)) return yield* client.execute(request);

  const streaming = HttpClientRequest.bodyJsonUnsafe(request, { ...body.value, stream: true });
  const response = yield* client.execute(streaming);
  // Effect's client reads the error from the body itself.
  if (response.status !== HTTP_OK) return response;

  const completed = completedResponse(yield* response.text);

  if (Option.isNone(completed)) {
    return yield* new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request,
        response,
        description: "The response stream ended without a response.completed event.",
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

/**
 * The response from the `response.completed` event, with its output rebuilt from the
 * `response.output_item.done` events. The Codex backend sometimes completes with an empty or null `output`
 * after sending every item, so the item events are the record of what was said, as for any
 * streaming client.
 */
const completedResponse = (stream: string) => {
  const payloads: string[] = [];

  const parser = Sse.makeParser((event) => {
    if (Predicate.isTagged(event, "Event")) payloads.push(event.data);
  });

  parser.feed(stream);

  const output = payloads
    .flatMap((payload) => Option.toArray(decodeOutputItemDone(payload)))
    .toSorted((first, second) => first.output_index - second.output_index)
    .flatMap(({ item }) => (item.phase === "commentary" ? [] : [item]));

  return Array.findFirst(payloads, (payload) => decodeCompletedEvent(payload)).pipe(
    Option.map(({ response }) => ({ ...response, output })),
  );
};
