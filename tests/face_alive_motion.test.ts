import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

type FaceAliveMode = "idle" | "tracking" | "saccade" | "blinking";

interface PupilState {
  x: number;
  y: number;
}

interface EyeState {
  leftOpenness: number;
  rightOpenness: number;
  leftPupil: PupilState;
  rightPupil: PupilState;
  mode: FaceAliveMode;
}

interface EyeSample {
  t: number;
  state: EyeState;
}

declare global {
  interface Window {
    __faceAlive?: {
      getEyeState: () => EyeState;
      activate: () => void;
      deactivate: () => void;
      forceBlink: (delayMs?: number) => void;
      setDebugOverlay: (visible: boolean) => void;
    };
  }
}

const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(REPO_ROOT, ".test-artifacts");
// Mirror the clamp geometry in face-alive.ts (SOCKET_RADIUS_X / EYE_MAX_UP_Y /
// EYE_MAX_DOWN_Y). Every reported pupil is a clampToSocket() output, so these
// are the exact bounds the gaze is held within.
const MAX_SOCKET_RADIUS_X = 20.5;
const MAX_SOCKET_RADIUS_UP_Y = 4.2;
const MAX_SOCKET_RADIUS_DOWN_Y = 14.0;
const EYE_CLIP = { x: 285, y: 245, width: 190, height: 70 };

test.setTimeout(120_000);

test("face alive eyes blink, track, saccade, and idle organically", async () => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const app = await electron.launch({
    args: [REPO_ROOT],
    env: {
      ...process.env,
      HEADSPACE_FACE_TEST: "1",
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.__faceAlive));

    await enableAliveMode(page);
    await page.waitForTimeout(800);

    const restSamples = await collectEyeSamples(page, 15_000, 16);
    const blinkSegments = findBlinkSegments(restSamples);
    expect(blinkSegments.length, "at least two rest blinks in 15 seconds").toBeGreaterThanOrEqual(2);

    // Phase durations are only knowable to ±1 sample (~16ms), so a single
    // blink whose samples land symmetrically can tie. Verify the close-faster-
    // than-open asymmetry in aggregate (median across blinks) instead, which
    // is robust to per-segment quantization while still strictly checking it.
    const closingDurations: number[] = [];
    const openingDurations: number[] = [];
    for (const segment of blinkSegments) {
      const minSample = segment.reduce((best, sample) =>
        sample.state.leftOpenness < best.state.leftOpenness ? sample : best,
      );
      expect(minSample.state.leftOpenness, "blink reaches near-full closure").toBeLessThanOrEqual(0.05);
      expect(minSample.state.rightOpenness, "right eye reaches near-full closure").toBeLessThanOrEqual(0.05);

      closingDurations.push(minSample.t - segment[0].t);
      openingDurations.push(segment[segment.length - 1].t - minSample.t);
    }
    expect(
      median(closingDurations),
      "median closing phase is shorter than median opening phase",
    ).toBeLessThan(median(openingDurations));

    // Smoothness: openness must move continuously, never teleport (the old
    // bitmap-lid "garage door" bug stepped instantly). Bound the change by a
    // RATE rather than a fixed per-sample delta — the fixed form silently
    // assumed an exact frame cadence, so a single jittered sample (animation
    // advancing ~1.5× a frame while wall-clock reads one) tripped it even
    // though the motion was a smooth linear ramp. The fastest designed phase
    // is the ~54ms close (~0.018 openness/ms); 0.03/ms allows generous
    // scheduler headroom while still flagging any real teleport (a 0.03→1.0
    // jump in one ~16ms frame is ~0.058/ms ≫ bound).
    const MAX_OPENNESS_RATE_PER_MS = 0.03;
    let adjacentFrameComparisons = 0;
    for (let i = 1; i < restSamples.length; i++) {
      const previous = restSamples[i - 1].state.leftOpenness;
      const next = restSamples[i].state.leftOpenness;
      const sampleGapMs = restSamples[i].t - restSamples[i - 1].t;
      if (sampleGapMs <= 18.5) {
        adjacentFrameComparisons++;
        const allowedJump = MAX_OPENNESS_RATE_PER_MS * sampleGapMs;
        expect(
          Math.abs(next - previous),
          `blink openness changes continuously at sample ${i} gap=${sampleGapMs.toFixed(1)}ms prev=${previous.toFixed(3)} next=${next.toFixed(3)} mode=${restSamples[i].state.mode}`,
        ).toBeLessThan(allowedJump);
      }
      assertPupilsInSocket(restSamples[i].state);
    }
    expect(adjacentFrameComparisons, "harness captured adjacent animation frames").toBeGreaterThan(100);

    await page.waitForTimeout(1_700);
    const idleSamples = await collectEyeSamples(page, 10_000, 100);
    const idleFixations = distinctFixationCount(idleSamples);
    expect(idleFixations, "idle wandering visits at least three fixation points").toBeGreaterThanOrEqual(3);
    for (const sample of idleSamples) assertPupilsInSocket(sample.state);

    const blinkFrames = await captureForcedBlink(app, page);
    const trackingFrames = await captureSlowMouseCircle(app, page);
    const idleFrames = await captureIdle(app, page);

    await disableAliveMode(page);

    await composeGrid(page, blinkFrames, path.join(ARTIFACT_DIR, "face-alive-blink-grid.png"));
    await composeGrid(page, trackingFrames, path.join(ARTIFACT_DIR, "face-alive-tracking-grid.png"));
    await composeGrid(page, idleFrames, path.join(ARTIFACT_DIR, "face-alive-idle-grid.png"));
  } finally {
    await app.close();
  }
});

async function enableAliveMode(page: Page): Promise<void> {
  const nose = page.locator("#nose-hitbox");
  for (let i = 0; i < 5; i++) {
    await nose.click({ force: true, position: { x: 18, y: 15 } });
    await page.waitForTimeout(40);
  }
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains("face-alive")), {
      timeout: 3000,
      message: "nose 5x toggle enables alive mode",
    })
    .toBe(true);
}

async function disableAliveMode(page: Page): Promise<void> {
  const nose = page.locator("#nose-hitbox");
  for (let i = 0; i < 5; i++) {
    await nose.click({ force: true, position: { x: 18, y: 15 } });
    await page.waitForTimeout(40);
  }
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains("face-alive")), {
      timeout: 3000,
      message: "nose 5x toggle disables alive mode",
    })
    .toBe(false);
}

async function collectEyeSamples(page: Page, durationMs: number, stepMs: number): Promise<EyeSample[]> {
  return page.evaluate(
    ({ durationMs: duration, stepMs: step }) =>
      new Promise<EyeSample[]>((resolve) => {
        const samples: EyeSample[] = [];
        const startedAt = performance.now();
        let lastSampleAt = -Infinity;

        const sample = (now: number) => {
          if (now - lastSampleAt >= step) {
            const state = window.__faceAlive?.getEyeState();
            if (state) samples.push({ t: now - startedAt, state });
            lastSampleAt = now;
          }
          if (now - startedAt < duration) requestAnimationFrame(sample);
          else resolve(samples);
        };

        requestAnimationFrame(sample);
      }),
    { durationMs, stepMs },
  );
}

function findBlinkSegments(samples: EyeSample[]): EyeSample[][] {
  const segments: EyeSample[][] = [];
  let current: EyeSample[] = [];
  for (const sample of samples) {
    if (sample.state.leftOpenness < 0.98 || sample.state.rightOpenness < 0.98) {
      current.push(sample);
      continue;
    }
    if (current.length > 0) {
      if (current.some((item) => item.state.leftOpenness <= 0.05)) segments.push(current);
      current = [];
    }
  }
  if (current.some((item) => item.state.leftOpenness <= 0.05)) segments.push(current);
  return segments;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function assertPupilsInSocket(state: EyeState): void {
  for (const pupil of [state.leftPupil, state.rightPupil]) {
    const maxY = pupil.y < 0 ? MAX_SOCKET_RADIUS_UP_Y : MAX_SOCKET_RADIUS_DOWN_Y;
    const normalized = Math.hypot(pupil.x / MAX_SOCKET_RADIUS_X, pupil.y / maxY);
    expect(normalized, "pupil remains inside socket ellipse").toBeLessThanOrEqual(1.02);
  }
}

function distinctFixationCount(samples: EyeSample[]): number {
  const accepted: PupilState[] = [];
  for (const sample of samples) {
    if (sample.state.mode !== "idle" && sample.state.mode !== "blinking") continue;
    const point = sample.state.leftPupil;
    const last = accepted.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 3.1) {
      accepted.push({ ...point });
    }
  }
  return accepted.length;
}

async function captureForcedBlink(app: ElectronApplication, page: Page): Promise<Buffer[]> {
  await page.waitForFunction(() => {
    const state = window.__faceAlive?.getEyeState();
    return Boolean(state && state.leftOpenness > 0.99 && state.mode !== "blinking");
  });
  await page.evaluate(() => window.__faceAlive?.forceBlink(180));
  return captureFrames(app, 16, 16);
}

async function captureSlowMouseCircle(app: ElectronApplication, page: Page): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  const center = { x: 378, y: 276 };
  const radiusX = 82;
  const radiusY = 48;
  for (let i = 0; i < 16; i++) {
    const theta = (i / 16) * Math.PI * 2;
    await page.mouse.move(center.x + Math.cos(theta) * radiusX, center.y + Math.sin(theta) * radiusY, {
      steps: 5,
    });
    await page.waitForTimeout(100);
    frames.push(await captureEyeClip(app));
  }
  return frames;
}

async function captureIdle(app: ElectronApplication, page: Page): Promise<Buffer[]> {
  await page.mouse.move(20, 20, { steps: 3 });
  await page.waitForTimeout(1_900);
  return captureFrames(app, 16, 200);
}

async function captureFrames(app: ElectronApplication, count: number, intervalMs: number): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(await captureEyeClip(app));
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return frames;
}

async function captureEyeClip(app: ElectronApplication): Promise<Buffer> {
  const base64 = await app.evaluate(
    async ({ BrowserWindow }, clip) => {
      const win = BrowserWindow.getAllWindows()[0];
      const image = await win.webContents.capturePage(clip);
      return image.toPNG().toString("base64");
    },
    EYE_CLIP,
  );
  return Buffer.from(base64, "base64");
}

async function composeGrid(page: Page, frames: Buffer[], filePath: string): Promise<void> {
  const html = `
    <!doctype html>
    <html>
      <head>
        <style>
          html, body {
            margin: 0;
            width: 549px;
            height: 394px;
            overflow: hidden;
            background: #061600;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            grid-template-rows: repeat(4, 1fr);
            width: 549px;
            height: 394px;
            gap: 0;
          }
          img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #061600;
          }
        </style>
      </head>
      <body>
        <div class="grid">
          ${frames
            .map((frame) => `<img src="data:image/png;base64,${frame.toString("base64")}" alt="">`)
            .join("")}
        </div>
      </body>
    </html>
  `;
  await page.setContent(html);
  await page.screenshot({ path: filePath });
}
