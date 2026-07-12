import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { XAI_OAUTH_CLIENT_ID, XAI_OAUTH_ISSUER } from "./constants.ts";

function expiry(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1_000_000_000_000) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseGrokCredentials(value: unknown): OAuthCredentials | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entry = (value as Record<string, unknown>)[`${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`];
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	const record = entry as Record<string, unknown>;
	const expires = expiry(record.expires_at);
	if (
		typeof record.key !== "string" ||
		!record.key ||
		typeof record.refresh_token !== "string" ||
		!record.refresh_token ||
		record.oidc_issuer !== XAI_OAUTH_ISSUER ||
		record.oidc_client_id !== XAI_OAUTH_CLIENT_ID ||
		expires === undefined
	) {
		return undefined;
	}
	return { access: record.key, refresh: record.refresh_token, expires };
}

export async function readGrokCredentials(): Promise<OAuthCredentials | undefined> {
	try {
		return parseGrokCredentials(JSON.parse(await readFile(join(homedir(), ".grok", "auth.json"), "utf8")));
	} catch {
		return undefined;
	}
}
