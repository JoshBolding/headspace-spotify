/**
 * Encrypted persistence for Spotify OAuth tokens.
 *
 * Uses Electron's safeStorage when available (DPAPI on Windows, Keychain on
 * macOS, libsecret on Linux). Falls back to plain JSON if the platform refuses
 * encryption — file is still confined to userData, never logged or transmitted.
 */

import { app, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scope: string;
}

function tokenPath() {
  return path.join(app.getPath("userData"), "spotify-tokens.bin");
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  const json = JSON.stringify(tokens);
  let buf: Buffer;
  if (safeStorage.isEncryptionAvailable()) {
    buf = safeStorage.encryptString(json);
  } else {
    buf = Buffer.from(json, "utf8");
  }
  await fs.writeFile(tokenPath(), buf);
}

export async function loadTokens(): Promise<StoredTokens | null> {
  try {
    const buf = await fs.readFile(tokenPath());
    let json: string;
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(buf);
    } else {
      json = buf.toString("utf8");
    }
    const parsed = JSON.parse(json) as StoredTokens;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(tokenPath());
  } catch {
    /* already gone */
  }
}
