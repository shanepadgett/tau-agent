import { Effect, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { end, initial, step } from "../shared/anthropic.ts";

export const stream = (url: string, body: object) =>
	HttpClient.HttpClient.pipe(
		Effect.flatMap((client) =>
			HttpClient.filterStatusOk(client).execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))),
		),
		HttpClientResponse.stream,
		Stream.decodeText,
		Stream.pipeThroughChannel(Sse.decode()),
		Stream.mapAccum(initial, step, { onHalt: end }),
	);
