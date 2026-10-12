// Local HTTP servers: a recording proxy for live runs and a replay server for offline runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Recording {
  readonly path: string;
  readonly request: unknown;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const RECORDINGS = join(process.cwd(), "recordings");

/** Forwards every request to `upstream`, keeps the last exchange, and never stores headers. */
export const recordingProxy = (upstream: string) => {
  const exchanges: Recording[] = [];

  const server = Bun.serve({
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("accept-encoding");

      const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: body === "" ? undefined : body,
      });

      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "text/plain";
      exchanges.push({
        path: `${url.pathname}${url.search}`,
        request: body === "" ? null : JSON.parse(body),
        status: response.status,
        contentType,
        body: text,
      });

      return new Response(text, { status: response.status, headers: { "content-type": contentType } });
    },
  });

  return { url: `http://localhost:${server.port}`, exchanges, stop: () => server.stop(true) };
};

/** Serves one recording for every request and records the Authorization header each request carried. */
export const replayServer = (recording: Recording) => {
  const authorizations: (string | null)[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      authorizations.push(request.headers.get("authorization"));
      return new Response(recording.body, {
        status: recording.status,
        headers: { "content-type": recording.contentType },
      });
    },
  });

  return { url: `http://localhost:${server.port}`, authorizations, stop: () => server.stop(true) };
};

/** Fails instead of saving when a secret appears anywhere in the recording. */
export const save = (name: string, recording: Recording, secrets: readonly string[]) => {
  // Codex responses carry a per-account `safety_identifier`; it is not a credential but it identifies the user.
  const json = JSON.stringify(recording, null, 2).replaceAll(/user-[A-Za-z0-9]{12,}/g, "user-redacted");
  const leaked = secrets.filter((secret) => secret.length > 8 && json.includes(secret));
  if (leaked.length > 0) throw new Error(`recording ${name} contains ${leaked.length} secret(s); not saved`);
  mkdirSync(RECORDINGS, { recursive: true });
  writeFileSync(join(RECORDINGS, `${name}.json`), `${json}\n`);
};

export const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(RECORDINGS, `${name}.json`), "utf8"));

export const saveJson = (name: string, value: unknown) => {
  mkdirSync(RECORDINGS, { recursive: true });
  writeFileSync(join(RECORDINGS, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
};

export const loadJson = (name: string): unknown =>
  JSON.parse(readFileSync(join(RECORDINGS, `${name}.json`), "utf8"));
