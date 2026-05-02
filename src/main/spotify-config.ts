/**
 * Spotify OAuth configuration. Reads SPOTIFY_CLIENT_ID from process env or
 * a .env file in the app root. The redirect URI must match what's registered
 * in the Spotify Developer Dashboard for this app.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

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
    const envPath = path.join(app.getAppPath(), ".env");
    try {
      const text = fs.readFileSync(envPath, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*SPOTIFY_CLIENT_ID\s*=\s*(.+?)\s*$/);
        if (m) clientId = m[1].replace(/^["']|["']$/g, "");
      }
    } catch {
      /* missing .env is fine; we'll throw below if env var also missing */
    }
  }
  if (!clientId) {
    throw new Error(
      "SPOTIFY_CLIENT_ID is not set. Add it to .env in the app root or set the env var.",
    );
  }
  cached = { clientId, redirectUri: REDIRECT_URI, scopes: SPOTIFY_SCOPES };
  return cached;
}
