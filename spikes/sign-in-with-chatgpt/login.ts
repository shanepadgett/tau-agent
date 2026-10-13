// Sign in with ChatGPT, open-source flow: first login registers "Tau" with dynamic_agent_client,
// later logins reuse the issued client ID. Tokens go to state/ (gitignored); nothing prints a token.
// Docs: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
import { chmod, mkdir } from "node:fs/promises";

const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${PORT}${CALLBACK_PATH}`;

const stateDir = `${import.meta.dir}/state`;
await mkdir(stateDir, { recursive: true, mode: 0o700 });

const hostIdFile = Bun.file(`${stateDir}/host-id.txt`);
const hostId = (await hostIdFile.exists())
  ? (await hostIdFile.text()).trim()
  : `urn:uuid:${crypto.randomUUID()}`;
await Bun.write(hostIdFile, hostId);

const credentialsFile = Bun.file(`${stateDir}/credentials.json`);
const saved = (await credentialsFile.exists()) ? await credentialsFile.json() : undefined;
const savedClientId: string | undefined = saved?.client_id;

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const verifier = random();
const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const state = random();
const nonce = random();

const params = new URLSearchParams({
  response_type: "code",
  client_id: savedClientId ?? "dynamic_agent_client",
  ...(savedClientId === undefined ? { agent_name_hint: "Tau" } : {}),
  ext_agent_host_id: hostId,
  redirect_uri: REDIRECT_URI,
  scope: SCOPE,
  resource: RESOURCE,
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: "S256",
  ...(saved?.id_token ? { id_token_hint: saved.id_token } : {}),
});

const callback = Promise.withResolvers<URLSearchParams>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 });
    callback.resolve(url.searchParams);
    return new Response("Tau received the login. You can close this tab.");
  },
});

const authorizeUrl = `${AUTHORIZE_URL}?${params}`;
console.log(`${savedClientId === undefined ? "Registering Tau" : "Signing in again"}. Open this address if the browser does not open:\n${authorizeUrl}\n`);
Bun.spawn(["open", authorizeUrl]);

const reply = await callback.promise;

if (reply.get("state") !== state) throw new Error("State mismatch");
if (reply.get("error")) throw new Error(`Login refused: ${reply.get("error")} ${reply.get("error_description") ?? ""}`);

const code = reply.get("code");
const issuedClientId = reply.get("client_id") ?? savedClientId;
if (!code || !issuedClientId) throw new Error(`Callback lacks code or client_id: ${[...reply.keys()].join(", ")}`);
if (savedClientId !== undefined && reply.get("client_id") && reply.get("client_id") !== savedClientId)
  throw new Error("Callback returned a different client ID than the saved registration");

const response = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: issuedClientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  }),
});

const tokens = await response.json();
// Stopping only now lets the browser receive the callback page first.
await server.stop(true);
if (!response.ok) throw new Error(`Token exchange failed (${response.status}): ${JSON.stringify(tokens)}`);

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
const idClaims = tokens.id_token ? claims(tokens.id_token) : undefined;

await Bun.write(
  credentialsFile,
  JSON.stringify({ ...tokens, client_id: issuedClientId, ext_agent_host_id: hostId, saved_at: new Date().toISOString() }, null, 2),
);
await chmod(credentialsFile.name!, 0o600);

console.log(JSON.stringify({
  clientIdPrefix: issuedClientId.slice(0, 7),
  callbackKeys: [...reply.keys()],
  tokenFields: Object.keys(tokens),
  scope: tokens.scope,
  hasPlanScope: String(tokens.scope ?? "").split(" ").includes("chatgpt.tokens.use.direct"),
  expiresIn: tokens.expires_in,
  idToken: idClaims && { iss: idClaims.iss, audMatches: [idClaims.aud].flat().includes(issuedClientId), nonceMatches: idClaims.nonce === nonce },
  accessTokenClaimKeys: Object.keys(claims(tokens.access_token)),
}, null, 2));
