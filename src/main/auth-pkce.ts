/**
 * Spotify OAuth 2.0 PKCE flow.
 *
 * Desktop apps can't keep a client secret, so we use PKCE: generate a random
 * code_verifier, send its SHA-256 hash as code_challenge during authorize,
 * then prove possession of the verifier when exchanging code for tokens.
 *
 * Reference: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
 */

import crypto from "node:crypto";

export function generateCodeVerifier(): string {
  // 32 bytes → 43 base64url chars; well within the 43-128 char limit Spotify allows.
  return crypto.randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state: string;
  showDialog?: boolean;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    code_challenge_method: "S256",
    code_challenge: opts.codeChallenge,
    scope: opts.scopes.join(" "),
    state: opts.state,
    show_dialog: opts.showDialog ? "true" : "false",
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

export async function exchangeCode(opts: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}

export async function refreshAccessToken(opts: {
  clientId: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<TokenResponse>;
}
