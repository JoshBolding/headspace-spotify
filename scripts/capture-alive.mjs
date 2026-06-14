// Scratch capture: launch the built app, enable alive mode, screenshot the
// full head + ears so we can eyeball the eyes/speakers in real context.
// Not part of the test suite. Run: node scripts/capture-alive.mjs
import { _electron as electron } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(REPO_ROOT, ".test-artifacts");

const app = await electron.launch({ args: [REPO_ROOT], env: { ...process.env, HEADSPACE_FACE_TEST: "1" } });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.__faceAlive));
  await mkdir(OUT, { recursive: true });

  // Open both ear drawers closed (default) and enable alive mode directly.
  await page.evaluate(() => window.__faceAlive?.activate());
  await page.waitForTimeout(2600); // let wake flourish settle

  const shot = async (name, clip) => {
    const b64 = await app.evaluate(async ({ BrowserWindow }, clip) => {
      const win = BrowserWindow.getAllWindows()[0];
      const img = await win.webContents.capturePage(clip);
      return img.toPNG().toString("base64");
    }, clip);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(OUT, name), Buffer.from(b64, "base64"));
  };

  // Full window (head + ears). Closed view is 549×394.
  await shot("alive-full.png", { x: 0, y: 0, width: 549, height: 394 });
  // Tight head crop for eyes.
  await shot("alive-head.png", { x: 261, y: 230, width: 234, height: 120 });

  // Move the mouse to drive gaze, capture again.
  await page.mouse.move(360, 120, { steps: 6 });
  await page.waitForTimeout(400);
  await shot("alive-head-lookup.png", { x: 261, y: 230, width: 234, height: 120 });
  await page.mouse.move(470, 330, { steps: 6 });
  await page.waitForTimeout(400);
  await shot("alive-head-lookdown.png", { x: 261, y: 230, width: 234, height: 120 });

  // ---- Speaker cones: at rest (painted) vs driven excursion ----
  // Both ears flank the head; capture the left ear (#eq-ear) speaker stack.
  const leftEarClip = { x: 195, y: 82, width: 95, height: 178 };
  await page.mouse.move(20, 20, { steps: 3 });
  await page.waitForTimeout(300);
  await shot("alive-speakers-rest.png", leftEarClip);
  // Pump synchronously (20 physics steps in one frame) to build the spring to
  // a strong excursion, then hold it (pumpCones sets a 500ms hold so this
  // loop's silent input doesn't damp it before the screenshot lands).
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) window.__faceAlive?.pumpCones(1.0, 0.7, 0.6, i % 6 === 0);
  });
  await shot("alive-speakers-driven.png", leftEarClip);
  await shot("alive-full-driven.png", { x: 0, y: 0, width: 549, height: 394 });

  // Toggle the audio HUD and capture its layout (no real audio in this run,
  // so it will read SYNTHETIC/NONE with flat bars — we're checking the layout).
  await page.keyboard.press("Control+Shift+A");
  await page.waitForTimeout(200);
  await shot("alive-audio-hud.png", { x: 0, y: 0, width: 160, height: 130 });
  await page.keyboard.press("Control+Shift+A"); // hide HUD again

  // Dismiss any status overlay (the Widevine dialog appears with no Spotify
  // auth and would intercept the click), then right-click the screen.
  await page.evaluate(() => {
    document.getElementById("status-overlay")?.classList.remove("show");
    document.getElementById("auth-overlay")?.setAttribute("data-show", "0");
  });
  await page.waitForTimeout(100);
  await page.mouse.click(360, 120, { button: "right" });
  await page.waitForTimeout(200);
  await shot("alive-vis-menu.png", { x: 0, y: 0, width: 549, height: 394 });
  await page.mouse.click(40, 360); // dismiss

  // Seek bar: force a fill width + magenta hue to verify it themes cleanly.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--theme-hue", "310");
    const f = document.getElementById("seek-fill");
    if (f) f.style.width = "46%";
  });
  await page.waitForTimeout(100);
  await shot("seek-bar-magenta.png", { x: 292, y: 214, width: 175, height: 26 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--theme-hue", "95");
  });
  await page.waitForTimeout(100);
  await shot("seek-bar-lime.png", { x: 292, y: 214, width: 175, height: 26 });

  // Report the speaker canvas screen rects so the clip can be aimed precisely.
  const rects = await page.evaluate(() => {
    const grab = (sel) =>
      Array.from(document.querySelectorAll(sel)).map((c) => {
        const r = c.getBoundingClientRect();
        return { id: c.parentElement?.id, cls: c.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      });
    return { canvas: grab(".speaker-cone-canvas"), earImg: grab(".ear-img") };
  });
  console.log("speaker canvas rects:", JSON.stringify(rects.canvas));
  console.log("ear-img rects:", JSON.stringify(rects.earImg));

  // ---- Milkdrop smoke test: select the mode (no live audio in test) and
  // confirm graceful fallback (idle hint, no crash). ----
  const milkdropState = await page.evaluate(() => {
    localStorage.setItem("headspace.spotify.viz-mode", "milkdrop");
    return "set";
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.__faceAlive));
  await page.waitForTimeout(1200);
  const milkdrop = await page.evaluate(() => ({
    bodyHasMilkdrop: document.body.classList.contains("vis-milkdrop"),
    bodyHasIdle: document.body.classList.contains("milkdrop-idle"),
    hintVisible: getComputedStyle(document.getElementById("milkdrop-hint")).display !== "none",
    canvasPresent: Boolean(document.getElementById("butterchurn-canvas")),
    consoleErrors: window.__errors || [],
  }));
  console.log("milkdrop state:", JSON.stringify(milkdrop), milkdropState);
  console.log("captured to", OUT);
} finally {
  await app.close();
}
