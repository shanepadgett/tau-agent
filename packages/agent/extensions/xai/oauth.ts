import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readGrokCredentials } from "./auth.ts";
import {
	XAI_OAUTH_CALLBACK_HOST,
	XAI_OAUTH_CALLBACK_PATH,
	XAI_OAUTH_CALLBACK_PORT,
	XAI_OAUTH_CLIENT_ID,
	XAI_OAUTH_ISSUER,
	XAI_OAUTH_SCOPE,
} from "./constants.ts";

const DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 180_000;
const REFRESH_SKEW_MS = 120_000;

interface Discovery {
	authorization_endpoint: string;
	token_endpoint: string;
}

interface TokenPayload {
	access_token?: unknown;
	refresh_token?: unknown;
	id_token?: unknown;
	expires_in?: unknown;
	token_type?: unknown;
}

interface HttpResponse {
	ok: boolean;
	status: number;
	body: { cancel(): Promise<void> } | null;
	json(): Promise<unknown>;
}

interface CallbackResult {
	code?: string;
	error?: string;
	errorDescription?: string;
}

function validatedEndpoint(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`xAI OAuth discovery omitted ${field}`);
	const url = new URL(value);
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`xAI OAuth discovery returned an unexpected ${field}`);
	}
	return url.toString();
}

function requestSignal(parent?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function discover(signal?: AbortSignal): Promise<Discovery> {
	const response = (await fetch(DISCOVERY_URL, {
		headers: { Accept: "application/json" },
		signal: requestSignal(signal),
	})) as HttpResponse;
	if (!response.ok) throw new Error(`xAI OAuth discovery failed with status ${response.status}`);
	const value: unknown = await response.json();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("xAI OAuth discovery returned invalid JSON");
	}
	const record = value as Record<string, unknown>;
	return {
		authorization_endpoint: validatedEndpoint(record.authorization_endpoint, "authorization_endpoint"),
		token_endpoint: validatedEndpoint(record.token_endpoint, "token_endpoint"),
	};
}

async function tokenRequest(endpoint: string, body: URLSearchParams, signal?: AbortSignal): Promise<TokenPayload> {
	const response = (await fetch(validatedEndpoint(endpoint, "token_endpoint"), {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal: requestSignal(signal),
	})) as HttpResponse;
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`xAI OAuth token request failed with status ${response.status}`);
	}
	return (await response.json()) as TokenPayload;
}

function jwtClaims(token: string): Record<string, unknown> {
	const segments = token.split(".");
	if (segments.length !== 3 || !segments[1]) throw new Error("xAI OAuth returned an invalid ID token");
	try {
		const value: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw new Error("xAI OAuth returned an invalid ID token");
	}
}

function credentials(payload: TokenPayload, endpoint: string, fallbackRefresh = "", nonce?: string): OAuthCredentials {
	if (typeof payload.access_token !== "string" || !payload.access_token) {
		throw new Error("xAI OAuth token response omitted the access token");
	}
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : fallbackRefresh;
	if (!refresh) throw new Error("xAI OAuth token response omitted the refresh token");
	if (nonce !== undefined) {
		if (typeof payload.id_token !== "string" || !payload.id_token)
			throw new Error("xAI OAuth token response omitted the ID token");
		const claims = jwtClaims(payload.id_token);
		const audience = claims.aud;
		const validAudience =
			audience === XAI_OAUTH_CLIENT_ID || (Array.isArray(audience) && audience.includes(XAI_OAUTH_CLIENT_ID));
		if (claims.iss !== XAI_OAUTH_ISSUER || !validAudience || claims.nonce !== nonce) {
			throw new Error("xAI OAuth ID token validation failed");
		}
		if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
			throw new Error("xAI OAuth returned an expired ID token");
		}
	}
	const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 3600;
	return {
		access: payload.access_token,
		refresh,
		expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
		tokenEndpoint: endpoint,
	};
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function callbackServer(expectedState: string): Promise<{
	redirectUri: string;
	wait(signal?: AbortSignal): Promise<CallbackResult>;
	acceptManual(input: string): string | undefined;
	close(): Promise<void>;
}> {
	let settle: ((result: CallbackResult) => void) | undefined;
	let reject: ((error: Error) => void) | undefined;
	let settled = false;
	const result = new Promise<CallbackResult>((resolve, rejectResult) => {
		settle = resolve;
		reject = rejectResult;
	});
	const accept = (value: CallbackResult) => {
		if (settled) return;
		settled = true;
		settle?.(value);
	};
	const parse = (params: URLSearchParams): CallbackResult | undefined => {
		if (params.get("state") !== expectedState) return undefined;
		const code = params.get("code") || undefined;
		const error = params.get("error") || undefined;
		if (!code && !error) return undefined;
		return { code, error, errorDescription: params.get("error_description") || undefined };
	};
	const server = createServer((request, response) => {
		const origin = request.headers.origin;
		if (origin === "https://accounts.x.ai" || origin === "https://auth.x.ai") {
			response.setHeader("Access-Control-Allow-Origin", origin);
			response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
			response.setHeader("Access-Control-Allow-Headers", "Content-Type");
			response.setHeader("Access-Control-Allow-Private-Network", "true");
			response.setHeader("Vary", "Origin");
		}
		if (request.method === "OPTIONS") {
			response.writeHead(204).end();
			return;
		}
		const url = new URL(request.url ?? "/", `http://${XAI_OAUTH_CALLBACK_HOST}`);
		if (request.method !== "GET" || url.pathname !== XAI_OAUTH_CALLBACK_PATH) {
			response.writeHead(404).end("Not found");
			return;
		}
		const parsed = parse(url.searchParams);
		if (!parsed) {
			response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Invalid OAuth callback");
			return;
		}
		response
			.writeHead(parsed.error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" })
			.end("<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>", () =>
				accept(parsed),
			);
	});
	const listen = (port: number) =>
		new Promise<number>((resolve, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(port, XAI_OAUTH_CALLBACK_HOST, () => {
				server.removeListener("error", rejectListen);
				const address = server.address();
				if (!address || typeof address === "string") rejectListen(new Error("Could not determine callback port"));
				else resolve(address.port);
			});
		});
	let port: number;
	try {
		port = await listen(XAI_OAUTH_CALLBACK_PORT);
	} catch {
		port = await listen(0);
	}
	return {
		redirectUri: `http://${XAI_OAUTH_CALLBACK_HOST}:${port}${XAI_OAUTH_CALLBACK_PATH}`,
		acceptManual(input) {
			try {
				const value = input.trim();
				const url = value.startsWith("http")
					? new URL(value)
					: new URL(`http://${XAI_OAUTH_CALLBACK_HOST}${XAI_OAUTH_CALLBACK_PATH}?${value.replace(/^\?/, "")}`);
				if (url.pathname !== XAI_OAUTH_CALLBACK_PATH) return "Callback URL path was not recognized";
				const parsed = parse(url.searchParams);
				if (!parsed) return "Callback state did not match";
				accept(parsed);
				return undefined;
			} catch {
				return "Callback URL was invalid";
			}
		},
		async wait(signal) {
			const timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					reject?.(new Error("Timed out waiting for xAI OAuth callback"));
				}
			}, LOGIN_TIMEOUT_MS);
			const onAbort = () => {
				if (!settled) {
					settled = true;
					reject?.(new Error("xAI OAuth login was cancelled"));
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				return await result;
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				await closeServer(server);
			}
		},
		close: () => closeServer(server),
	};
}

async function refreshXaiCredentials(value: OAuthCredentials): Promise<OAuthCredentials> {
	if (!value.refresh) throw new Error("xAI OAuth credential cannot be refreshed; run /login again");
	const endpoint =
		typeof value.tokenEndpoint === "string" && value.tokenEndpoint
			? validatedEndpoint(value.tokenEndpoint, "token_endpoint")
			: (await discover()).token_endpoint;
	const payload = await tokenRequest(
		endpoint,
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: XAI_OAUTH_CLIENT_ID,
			refresh_token: value.refresh,
		}),
	);
	return credentials(payload, endpoint, value.refresh);
}

export const xaiOAuth = {
	name: "xAI (Grok subscription)",
	usesCallbackServer: true,
	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		const existing = await readGrokCredentials();
		if (existing) {
			const method = await callbacks.onSelect({
				message: "Select xAI login method:",
				options: [
					{ id: "browser", label: "Browser login" },
					{ id: "existing", label: "Use existing Grok CLI login" },
				],
			});
			if (!method) throw new Error("Login cancelled");
			if (method === "existing") {
				if (existing.expires > Date.now()) return existing;
				try {
					return await refreshXaiCredentials(existing);
				} catch {
					callbacks.onProgress?.("The existing Grok CLI login could not be refreshed. Starting browser login.");
				}
			}
		}
		const discovery = await discover(callbacks.signal);
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const state = randomBytes(24).toString("base64url");
		const nonce = randomBytes(24).toString("base64url");
		const callback = await callbackServer(state);
		try {
			const url = new URL(discovery.authorization_endpoint);
			url.search = new URLSearchParams({
				response_type: "code",
				client_id: XAI_OAUTH_CLIENT_ID,
				redirect_uri: callback.redirectUri,
				scope: XAI_OAUTH_SCOPE,
				code_challenge: challenge,
				code_challenge_method: "S256",
				state,
				nonce,
			}).toString();
			callbacks.onAuth({ url: url.toString(), instructions: "Authorize xAI in your browser, then return to Tau." });
			if (callbacks.onManualCodeInput) {
				void callbacks
					.onManualCodeInput()
					.then((input) => {
						const error = callback.acceptManual(input);
						if (error) callbacks.onProgress?.(`Ignored pasted callback: ${error}`);
					})
					.catch(() => undefined);
			}
			const result = await callback.wait(callbacks.signal);
			if (result.error) throw new Error(`xAI authorization failed: ${result.errorDescription ?? result.error}`);
			if (!result.code) throw new Error("xAI authorization did not return a code");
			const payload = await tokenRequest(
				discovery.token_endpoint,
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: XAI_OAUTH_CLIENT_ID,
					code: result.code,
					redirect_uri: callback.redirectUri,
					code_verifier: verifier,
				}),
				callbacks.signal,
			);
			return credentials(payload, discovery.token_endpoint, "", nonce);
		} finally {
			await callback.close();
		}
	},
	refreshToken: refreshXaiCredentials,
	getApiKey(value: OAuthCredentials): string {
		return value.access;
	},
};
