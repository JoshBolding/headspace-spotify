/**
 * LRC parser + position-driven line lookup.
 *
 * LRC format example:
 *   [00:12.34] First line of lyrics
 *   [00:15.78] Second line
 *   [01:02.10]
 *
 * Empty timestamp markers (instrumental breaks) are kept so the UI can
 * render a blank slot instead of holding the previous line indefinitely.
 *
 * Lookup is O(log n) via binary search on the sorted timeline.
 */

export interface LyricsLine {
  timeMs: number;
  text: string;
}

export interface LyricsTrack {
  lines: LyricsLine[];
  /** Plain (unsynced) text, when synced wasn't available. Each entry = one line. */
  plain: string[];
  hasSynced: boolean;
  instrumental: boolean;
}

/** Parse an LRC text blob into a sorted timeline of lines. */
export function parseLrc(lrc: string): LyricsLine[] {
  const out: LyricsLine[] = [];
  // Each "line" can carry multiple timestamps (rare, but spec-allowed):
  //   [00:12.34][00:48.10] La la la
  const tagRe = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps: number[] = [];
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(raw)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] ?? "0";
      // Fractional digits can be 1-3; normalize to ms.
      const frac =
        fracRaw.length === 1
          ? parseInt(fracRaw, 10) * 100
          : fracRaw.length === 2
            ? parseInt(fracRaw, 10) * 10
            : parseInt(fracRaw, 10);
      stamps.push(min * 60_000 + sec * 1000 + frac);
      lastIdx = m.index + m[0].length;
    }
    if (!stamps.length) continue;
    const text = raw.slice(lastIdx).trim();
    for (const t of stamps) out.push({ timeMs: t, text });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/**
 * Find the index of the line that should currently be displayed for the
 * given playback position. Returns -1 if no line is active yet (we're before
 * the first timestamp).
 */
export function findActiveLineIndex(lines: LyricsLine[], positionMs: number): number {
  if (!lines.length) return -1;
  // Binary search for the largest timeMs <= positionMs.
  let lo = 0;
  let hi = lines.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].timeMs <= positionMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Build a LyricsTrack from raw lrclib payload. Splits plain text on newlines.
 */
export function buildLyricsTrack(payload: {
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}): LyricsTrack {
  const synced = payload.synced ? parseLrc(payload.synced) : [];
  const plain = payload.plain
    ? payload.plain.split(/\r?\n/).map((l) => l.trim())
    : [];
  return {
    lines: synced,
    plain,
    hasSynced: synced.length > 0,
    instrumental: payload.instrumental,
  };
}
