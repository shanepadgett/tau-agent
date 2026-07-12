import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGrokCredentials } from "../../../extensions/xai/auth.ts";
import { XAI_OAUTH_CLIENT_ID, XAI_OAUTH_ISSUER } from "../../../extensions/xai/constants.ts";
import { xaiOAuth } from "../../../extensions/xai/oauth.ts";

interface FetchCallInit {
	body?: unknown;
}

afterEach(() => vi.unstubAllGlobals());

describe("xAI Grok credential import", () => {
	it("accepts the official Grok CLI credential shape", () => {
		const expires = Date.now() + 60_000;
		expect(
			parseGrokCredentials({
				[`${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`]: {
					key: "access",
					refresh_token: "refresh",
					expires_at: expires,
					oidc_issuer: XAI_OAUTH_ISSUER,
					oidc_client_id: XAI_OAUTH_CLIENT_ID,
				},
			}),
		).toEqual({ access: "access", refresh: "refresh", expires });
	});

	it("rejects credentials for another issuer or client", () => {
		const entry = {
			key: "access",
			refresh_token: "refresh",
			expires_at: Date.now() + 60_000,
			oidc_issuer: "https://attacker.invalid",
			oidc_client_id: XAI_OAUTH_CLIENT_ID,
		};
		expect(parseGrokCredentials({ [`${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`]: entry })).toBeUndefined();
	});

	it("refreshes and rotates OAuth credentials", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) =>
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const result = await xaiOAuth.refreshToken({
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
			tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
		});
		expect(result).toMatchObject({ access: "new-access", refresh: "new-refresh" });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(`${XAI_OAUTH_ISSUER}/oauth2/token`);
		expect(String(init?.body)).toBe(
			`grant_type=refresh_token&client_id=${XAI_OAUTH_CLIENT_ID}&refresh_token=old-refresh`,
		);
	});
});
