/**
 * Spotify OAuth configuration. Reads SPOTIFY_CLIENT_ID from process env or
 * a .env file in the app root. The redirect URI must match what's registered
 * in the Spotify Developer Dashboard for this app.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const REDIRECT_PORT = 8888;
export const OAUTH_FALLBACK_PORTS = [8888, 8889, 8890, 8891, 8892, 8893] as const;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

export function redirectUriForPort(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-top-read",
  "user-read-recently-played",
  "user-read-playback-position",
  "user-follow-read",
];

interface Config {
  clientId: string;
  redirectUri: string;
  scopes: string[];
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    const candidates = [
      path.join(app.getAppPath(), ".env"),
      path.join(path.dirname(app.getPath("exe")), ".env"),
      path.join(app.getPath("userData"), ".env"),
    ];
    for (const envPath of candidates) {
      try {
        const text = fs.readFileSync(envPath, "utf8");
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^\s*SPOTIFY_CLIENT_ID\s*=\s*(.+?)\s*$/);
          if (m) {
            clientId = m[1].replace(/^["']|["']$/g, "");
            break;
          }
        }
        if (clientId) break;
      } catch {
        /* try the next location */
      }
    }
  }
  if (!clientId) {
    throw new Error(
      "SPOTIFY_CLIENT_ID is not set. Add it to .env next to the app, in userData, or set the env var.",
    );
  }
  cached = { clientId, redirectUri: REDIRECT_URI, scopes: SPOTIFY_SCOPES };
  return cached;
}
