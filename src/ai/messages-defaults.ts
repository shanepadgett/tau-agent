/** Adds the fields that Anthropic always sends to Messages replies from other servers, because Effect's Anthropic client needs them. */

import { Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const HTTP_OK = 200;
const DATA_PREFIX = "data: ";

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const WithUsage = Schema.StructWithRest(Schema.Struct({ usage: Schema.optionalKey(JsonObject) }), [
  JsonObject,
]);

type WithUsage = typeof WithUsage.Type;

/** A whole reply (`type: "message"`) or one stream event. */
const Reply = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(WithUsage),
    content_block: Schema.optionalKey(JsonObject),
    delta: Schema.optionalKey(JsonObject),
    usage: Schema.optionalKey(JsonObject),
  }),
  [JsonObject],
);

type Reply = typeof Reply.Type;

const ReplyJson = Schema.fromJsonString(Reply);
const decodeReply = Schema.decodeUnknownOption(ReplyJson);
const encodeReply = Schema.encodeSync(ReplyJson);

// Anthropic sends these fields as null when they do not apply, and its API description gives null
// as their default. Effect's schema requires them, so a server that leaves them out fails to decode.
const MESSAGE_DEFAULTS = { stop_reason: null, stop_sequence: null };

const MESSAGE_USAGE_DEFAULTS = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  service_tier: null,
};

const DELTA_USAGE_DEFAULTS = {
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  input_tokens: null,
};

/** Adds the missing fields to each reply the client receives. Replies that have all fields do not change. */
export const withMessagesDefaults = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transformResponse(client, Effect.map(withResponseDefaults));

const withResponseDefaults = (response: HttpClientResponse.HttpClientResponse) => {
  // Effect's client reads an error from the body itself.
  if (response.status !== HTTP_OK) return response;
  const isStream = response.headers["content-type"]?.startsWith("text/event-stream") === true;

  const body = isStream
    ? Stream.toReadableStream(
        response.stream.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.map((line) => `${withLineDefaults(line)}\n`),
          Stream.encodeText,
        ),
      )
    : Stream.toReadableStream(
        Stream.fromEffect(response.text).pipe(Stream.map(withBodyDefaults), Stream.encodeText),
      );

  // The changed body has a different length.
  const { "content-length": _length, ...headers } = response.headers;

  return HttpClientResponse.fromWeb(
    response.request,
    new Response(body, { status: HTTP_OK, headers }),
  );
};

const withBodyDefaults = (text: string) =>
  Option.match(decodeReply(text), {
    onNone: () => text,
    onSome: (reply) => encodeReply(withReplyDefaults(reply)),
  });

const withLineDefaults = (line: string) => {
  if (!line.startsWith(DATA_PREFIX)) return line;
  return `${DATA_PREFIX}${withBodyDefaults(line.slice(DATA_PREFIX.length))}`;
};

const withReplyDefaults = (reply: Reply): Reply => {
  switch (reply.type) {
    case "message":
      return withMessageDefaults(reply);

    case "message_start":
      return reply.message === undefined
        ? reply
        : { ...reply, message: withMessageDefaults(reply.message) };

    // Anthropic starts a thinking block with an empty signature, and sends the signature at the end.
    case "content_block_start":
      return reply.content_block?.type === "thinking"
        ? { ...reply, content_block: { signature: "", ...reply.content_block } }
        : reply;

    case "message_delta":
      return {
        ...reply,
        delta: { ...MESSAGE_DEFAULTS, ...reply.delta },
        usage: { ...DELTA_USAGE_DEFAULTS, ...reply.usage },
      };

    case undefined:
    default:
      return reply;
  }
};

const withMessageDefaults = (message: WithUsage) => ({
  ...MESSAGE_DEFAULTS,
  ...message,
  usage: { ...MESSAGE_USAGE_DEFAULTS, ...message.usage },
});
