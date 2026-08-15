/**
 * Seek bar: click-to-jump plus drag-scrub. While the pointer is down we
 * only paint the fill; Spotify hears about it on release so we don't
 * hammer /seek with every pixel.
 */

import type { SpotifyController } from "./spotify-player";
import type { StatusOverlay } from "./status-overlay";

export function wireSeekBar(
  controller: SpotifyController,
  status: StatusOverlay,
): { isScrubbing: () => boolean } {
  const track = document.getElementById("seek-track");
  const fill = document.getElementById("seek-fill") as HTMLDivElement | null;
  let scrubbing = false;

  if (!track || !fill) return { isScrubbing: () => false };

  const pctFromEvent = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };

  const paint = (pct: number) => {
    fill.style.width = `${pct * 100}%`;
  };

  const commit = async (pct: number) => {
    const dur = controller.state().durationMs;
    if (dur <= 0) return;
    await status.runPlaybackCommand(controller, "Seek", () => controller.seek(pct * dur));
  };

  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (controller.state().durationMs <= 0) return;
    e.preventDefault();
    scrubbing = true;
    track.setPointerCapture(e.pointerId);
    paint(pctFromEvent(e));
  });

  track.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    paint(pctFromEvent(e));
  });

  const end = (e: PointerEvent) => {
    if (!scrubbing) return;
    scrubbing = false;
    const pct = pctFromEvent(e);
    paint(pct);
    void commit(pct);
  };

  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", () => {
    scrubbing = false;
  });

  return { isScrubbing: () => scrubbing };
}
