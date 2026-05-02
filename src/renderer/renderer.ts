/**
 * Spotify-edition renderer entry.
 *
 * Wires alpha hit-test, drag, transport, library browser, and the Spotify
 * controller (Web Playback SDK with Connect-mode fallback). The skin chrome
 * is unchanged from v1; the audio engine and library are entirely new.
 */

import { Visualizer, VIS_MODES, buildSyntheticAnalysis } from "./visualizer";
import { SkinState } from "./skin-state";
import { Transport } from "./transport";
import { SkinSlider } from "./skin-slider";
import { SpotifyController, type SpotifyState } from "./spotify-player";
import { LibraryBrowser } from "./library-browser";
import { LiveAudio } from "./live-audio";
import { extractPalette, DEFAULT_PALETTE } from "./palette";
import { THEMES, getTheme, applyTheme, autoThemeFromHue } from "./themes";
import { STORAGE_KEYS } from "./storage-keys";
import { FaceAlive } from "./face-alive";
import { attachMediaSession } from "./media-session";
import { QueueView } from "./queue-view";
import {
  buildLyricsTrack,
  findActiveLineIndex,
  type LyricsTrack,
} from "./lyrics";

interface AuthStatus {
  authenticated: boolean;
  expiresAt?: number;
  scope?: string;
}

declare global {
  interface Window {
    headspace: {
      hitTest: (isOverOpaque: boolean) => void;
      minimize: () => void;
      close: () => void;
      setSize: (w: number, h: number) => void;
      dragStart: (dx: number, dy: number) => void;
      dragEnd: () => void;
      toggleOnTop: () => void;

      authStatus: () => Promise<AuthStatus>;
      authSignIn: (opts?: { showDialog?: boolean }) => Promise<{ success: boolean; error?: string }>;
      authSignOut: () => Promise<boolean>;
      authGetToken: () => Promise<string | null>;
      onAuthChanged: (cb: (status: AuthStatus) => void) => () => void;

      spUser: () => Promise<unknown>;
      spLiked: (offset: number, limit: number) => Promise<unknown>;
      spPlaylists: (offset: number, limit: number) => Promise<unknown>;
      spRecent: (limit: number) => Promise<unknown>;
      spSearch: (query: string, limit: number) => Promise<unknown>;
      spPlaylistTracks: (id: string, offset: number, limit: number) => Promise<unknown>;
      spDevices: () => Promise<unknown>;
      spTransfer: (deviceId: string, play: boolean) => Promise<unknown>;
      spPlay: (opts: object) => Promise<unknown>;
      spPause: (deviceId?: string) => Promise<unknown>;
      spNext: (deviceId?: string) => Promise<unknown>;
      spPrevious: (deviceId?: string) => Promise<unknown>;
      spSeek: (positionMs: number, deviceId?: string) => Promise<unknown>;
      spSetVolume: (percent: number, deviceId?: string) => Promise<unknown>;
      spState: () => Promise<unknown>;
      spQueue: () => Promise<unknown>;
      spAddQueue: (uri: string, deviceId?: string) => Promise<unknown>;
      spAnalysis: (trackId: string) => Promise<unknown>;
      systemDiag: () => Promise<unknown>;
      systemResetWidevine: () => Promise<unknown>;
      getLoopbackSourceId: () => Promise<string | null>;
      getLyrics: (req: {
        trackId: string;
        artist: string;
        track: string;
        album?: string;
        durationSec?: number;
      }) => Promise<{
        synced: string | null;
        plain: string | null;
        instrumental: boolean;
        source: string;
      }>;
    };
  }
}

const HEAD_W = 234;
const HEAD_H = 394;
const HEAD_X = 261;
const ALPHA_THRESHOLD = 16;

let headMask: Uint8Array | null = null;

async function buildHeadMask(): Promise<void> {
  const img = new Image();
  img.src = "head.png";
  await img.decode();
  const c = document.createElement("canvas");
  c.width = HEAD_W;
  c.height = HEAD_H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, HEAD_W, HEAD_H);
  const data = ctx.getImageData(0, 0, HEAD_W, HEAD_H).data;
  const mask = new Uint8Array(HEAD_W * HEAD_H);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  }
  headMask = mask;
  drawDebugMask(mask);
}

function drawDebugMask(mask: Uint8Array): void {
  const canvas = document.getElementById("debug-mask") as HTMLCanvasElement;
  canvas.width = HEAD_W;
  canvas.height = HEAD_H;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(HEAD_W, HEAD_H);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      imageData.data[i * 4 + 0] = 255;
      imageData.data[i * 4 + 2] = 255;
      imageData.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function isHeadPixel(x: number, y: number): boolean {
  if (!headMask) return false;
  const hx = Math.floor(x - HEAD_X);
  const hy = Math.floor(y);
  if (hx < 0 || hy < 0 || hx >= HEAD_W || hy >= HEAD_H) return false;
  return headMask[hy * HEAD_W + hx] === 1;
}

function isOpaqueAt(x: number, y: number): boolean {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.dataset.opaque === "1") return true;
    if (el.classList.contains("hotzone")) return true;
    if (el.classList.contains("ear-handle")) return true;
    if (el.classList.contains("drawer-body")) return true;
    if (el.closest(".drawer-body")) return true;
    if (el.id === "transport" || el.id === "seek-track") return true;
    if (el.classList.contains("ear-img")) return true;
  }
  return isHeadPixel(x, y);
}

function wireHitTesting(): void {
  let lastState: boolean | null = null;
  document.addEventListener(
    "pointermove",
    (e) => {
      const opaque = isOpaqueAt(e.clientX, e.clientY);
      if (opaque !== lastState) {
        lastState = opaque;
        window.headspace.hitTest(opaque);
      }
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => {
    if (lastState !== false) {
      lastState = false;
      window.headspace.hitTest(false);
    }
  });
}

function wireDrag(): void {
  const drag = document.getElementById("drag");
  if (!drag) return;
  let dragging = false;
  drag.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!isHeadPixel(e.clientX, e.clientY)) return;
    e.preventDefault();
    dragging = true;
    window.headspace.dragStart(e.clientX, e.clientY);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    window.headspace.dragEnd();
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", end);
}

function wireKeys(controller: SpotifyController): void {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "d")
      document.body.classList.toggle("debug");
    if (e.key === "Escape") window.headspace.close();
    if (e.ctrlKey && e.key.toLowerCase() === "t") window.headspace.toggleOnTop();
    if (e.code === "Space") {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      void controller.togglePlay();
    }
  });
}

function wireSpotifyAuth(onAuthed: () => void): void {
  const overlay = document.getElementById("auth-overlay")!;
  const btn = document.getElementById("btn-spotify-signin") as HTMLButtonElement;
  const status = document.getElementById("auth-status-text")!;

  function applyStatus(s: AuthStatus) {
    overlay.setAttribute("data-show", s.authenticated ? "0" : "1");
    btn.disabled = false;
    btn.textContent = "Sign in";
    status.textContent = "";
    if (s.authenticated) onAuthed();
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Opening browser…";
    status.textContent = "Complete sign-in in your browser, then return here.";
    const result = await window.headspace.authSignIn({ showDialog: true });
    if (!result.success) {
      btn.disabled = false;
      btn.textContent = "Sign in";
      status.textContent =
        result.error === "timeout"
          ? "Sign-in timed out. Try again."
          : `Sign-in failed: ${result.error ?? "unknown error"}`;
    }
  });

  window.headspace.onAuthChanged(applyStatus);
  void window.headspace.authStatus().then(applyStatus);
}

(async () => {
  await buildHeadMask();
  wireHitTesting();
  wireDrag();

  const vizCanvas = document.getElementById("vis-canvas") as HTMLCanvasElement;
  const viz = new Visualizer(vizCanvas);
  const liveAudio = new LiveAudio();

  // ---------- Easter-egg: alive-face mode ----------
  // 5 left-clicks on the nose hitbox within 2s toggles the head's "alive"
  // mode (eyes open + glow, ears throb to beat, head sways/bobs). Hidden
  // from any visible UI — discoverable only by playing with it.
  const faceAlive = new FaceAlive();
  const NOSE_CLICKS_REQUIRED = 5;
  const NOSE_CLICK_WINDOW_MS = 2000;
  let noseClicks = 0;
  let noseClickResetTimer: number | null = null;
  const noseHitbox = document.getElementById("nose-hitbox");
  noseHitbox?.addEventListener("click", () => {
    noseClicks++;
    if (noseClickResetTimer !== null) window.clearTimeout(noseClickResetTimer);
    noseClickResetTimer = window.setTimeout(() => {
      noseClicks = 0;
      noseClickResetTimer = null;
    }, NOSE_CLICK_WINDOW_MS);
    if (noseClicks >= NOSE_CLICKS_REQUIRED) {
      noseClicks = 0;
      if (noseClickResetTimer !== null) {
        window.clearTimeout(noseClickResetTimer);
        noseClickResetTimer = null;
      }
      faceAlive.toggle();
      flashVisLabel(faceAlive.isActive() ? "★ Alive Mode" : "☆ Sleep");
    }
  });
  /**
   * Try the cheap audio-element tap first; if blocked by DRM (almost always),
   * fall through to WASAPI loopback via desktopCapturer. Both are gestureless
   * so this can run automatically on SDK ready.
   */
  async function tryEnableLiveAudio(): Promise<void> {
    if (liveAudio.getSource()) return; // already attached
    // Wait a beat for the SDK to actually create its <audio> element.
    await new Promise((r) => setTimeout(r, 1500));
    if (await liveAudio.tryTap()) {
      viz.setLiveAudio(liveAudio);
      faceAlive.setLiveAudio(liveAudio);
      refreshBalanceAvailability();
      console.log("[viz] live audio: tap succeeded");
      return;
    }
    if (await liveAudio.tryLoopback()) {
      viz.setLiveAudio(liveAudio);
      faceAlive.setLiveAudio(liveAudio);
      refreshBalanceAvailability();
      console.log(
        "[viz] live audio: loopback active (capturing system audio — captures ALL audio, not just Spotify)",
      );
      return;
    }
    refreshBalanceAvailability();
    console.warn(
      "[viz] no live audio source available — falling back to synthetic 120 BPM analysis. Press Ctrl+L to retry.",
    );
  }

  // Ctrl+L → manual retry if auto-init failed for some reason.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      void tryEnableLiveAudio();
    }
  });

  // ---------- Theme cycler ----------
  let currentThemeId = localStorage.getItem(STORAGE_KEYS.theme) ?? "lime";
  let lastAutoHue: number | null = null;

  const themeBtn = document.getElementById("btn-theme-toggle") as HTMLButtonElement;
  const THEME_BUTTON_LABELS: Record<string, string> = {
    crimson: "CRIMS",
    magenta: "MAGEN",
    cobalt: "COB",
    auto: "AUTO",
  };

  function applyCurrentTheme(): void {
    const base = getTheme(currentThemeId);
    if (base.id === "auto" && lastAutoHue !== null) {
      applyTheme(autoThemeFromHue(lastAutoHue));
    } else {
      applyTheme(base);
    }
    themeBtn.textContent = THEME_BUTTON_LABELS[base.id] ?? base.name.toUpperCase();
    themeBtn.title = `Theme: ${base.name}`;
  }
  applyCurrentTheme();

  themeBtn.addEventListener("click", () => {
    const idx = THEMES.findIndex((t) => t.id === currentThemeId);
    const next = THEMES[(idx + 1) % THEMES.length];
    currentThemeId = next.id;
    localStorage.setItem(STORAGE_KEYS.theme, currentThemeId);
    applyCurrentTheme();
    flashVisLabel(`Theme: ${next.name}`);
  });

  /** Called when album-art palette is extracted; updates Auto theme. */
  function setAutoThemeHue(hueDeg: number) {
    lastAutoHue = hueDeg;
    if (currentThemeId === "auto") applyCurrentTheme();
  }

  // ---------- Lyrics state + UI ----------
  let lyricsEnabled = localStorage.getItem(STORAGE_KEYS.lyricsOn) === "1";
  let currentLyrics: LyricsTrack | null = null;
  let lyricsTrackId: string | null = null;
  let lyricsLoading = false;
  let lastRenderedLineIdx = -2;
  const lyricsBtn = document.getElementById("btn-lyrics-toggle") as HTMLButtonElement;
  const lyricsOverlay = document.getElementById("lyrics-overlay")!;
  const lyPrev = document.getElementById("ly-prev")!;
  const lyCurrent = document.getElementById("ly-current")!;
  const lyNext = document.getElementById("ly-next")!;

  function refreshLyricsButton() {
    lyricsBtn.classList.toggle("active", lyricsEnabled);
    lyricsOverlay.classList.toggle("show", lyricsEnabled && !!currentLyrics);
  }
  refreshLyricsButton();

  lyricsBtn.addEventListener("click", () => {
    lyricsEnabled = !lyricsEnabled;
    localStorage.setItem(STORAGE_KEYS.lyricsOn, lyricsEnabled ? "1" : "0");
    refreshLyricsButton();
    // If turned on without a track loaded yet, kick a fetch.
    if (lyricsEnabled) {
      const s = controller.state();
      if (s.track) void loadLyricsForCurrentTrack();
    }
  });

  async function loadLyricsForCurrentTrack(): Promise<void> {
    const s = controller.state();
    if (!s.track) return;
    if (lyricsLoading) return;
    if (s.track.id === lyricsTrackId && currentLyrics) return;
    lyricsLoading = true;
    lyricsTrackId = s.track.id;
    currentLyrics = null;
    lastRenderedLineIdx = -2;
    showLyricsStatus("Loading lyrics…");
    try {
      const res = await window.headspace.getLyrics({
        trackId: s.track.id,
        artist: s.track.artists[0]?.name ?? "",
        track: s.track.name,
        album: s.track.album.name,
        durationSec: s.durationMs ? Math.round(s.durationMs / 1000) : undefined,
      });
      // Discard if user already moved on to another track during the fetch.
      if (lyricsTrackId !== s.track.id) return;
      currentLyrics = buildLyricsTrack(res);
      if (currentLyrics.instrumental) {
        showLyricsStatus("♪ instrumental");
      } else if (!currentLyrics.hasSynced && currentLyrics.plain.length === 0) {
        showLyricsStatus("No lyrics found");
      } else if (!currentLyrics.hasSynced) {
        showPlainLyrics(currentLyrics.plain);
      }
      refreshLyricsButton();
    } finally {
      lyricsLoading = false;
    }
  }

  function showLyricsStatus(text: string) {
    lyPrev.textContent = "";
    lyCurrent.innerHTML = `<span class="ly-status">${escapeHtml(text)}</span>`;
    lyNext.textContent = "";
  }

  function showPlainLyrics(lines: string[]) {
    // Plain lyrics: render the first 6 non-empty lines stacked. No sync.
    const first = lines.filter((l) => l.length > 0).slice(0, 6);
    lyPrev.textContent = "";
    lyCurrent.textContent = first.join("\n");
    lyNext.innerHTML = `<span class="ly-status">(unsynced)</span>`;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function tickLyrics(positionMs: number) {
    if (!lyricsEnabled || !currentLyrics || !currentLyrics.hasSynced) return;
    const idx = findActiveLineIndex(currentLyrics.lines, positionMs);
    if (idx === lastRenderedLineIdx) return;
    lastRenderedLineIdx = idx;
    const lines = currentLyrics.lines;
    const cur = idx >= 0 ? lines[idx]?.text ?? "" : "";
    const prev = idx > 0 ? lines[idx - 1]?.text ?? "" : "";
    const next = idx + 1 < lines.length ? lines[idx + 1]?.text ?? "" : "";
    lyPrev.textContent = prev;
    lyCurrent.textContent = cur || "♪";
    lyNext.textContent = next;
  }

  // Replace the original EQ panel (Headspace v1 used 5 EQ bands + balance
  // sliders, neither of which Spotify exposes via the Web Playback SDK) with
  // working Volume + Balance sliders and a Queue placeholder.
  setupQueueDrawerStub();

  const skin = new SkinState({
    plEar: document.getElementById("pl-ear")!,
    eqEar: document.getElementById("eq-ear")!,
    plHandle: document.getElementById("btn-pl-handle")!,
    eqHandle: document.getElementById("btn-eq-handle")!,
  });

  // Drawer toggles
  document
    .getElementById("btn-pl-handle")!
    .addEventListener("click", () => skin.togglePlaylist());
  document
    .getElementById("btn-pl-open")!
    .addEventListener("click", () => skin.togglePlaylist());
  document
    .getElementById("btn-eq-handle")!
    .addEventListener("click", () => skin.toggleEq());
  document
    .getElementById("btn-eq-open")!
    .addEventListener("click", () => skin.toggleEq());

  // Window controls
  document
    .getElementById("btn-minimize")!
    .addEventListener("click", () => window.headspace.minimize());
  document
    .getElementById("btn-close")!
    .addEventListener("click", () => window.headspace.close());

  // Now-playing strip
  const nowPlaying = document.getElementById("now-playing")!;
  const pauseOverlay = document.getElementById("pause-overlay")!;

  const controller = new SpotifyController();
  wireKeys(controller);
  attachMediaSession(controller);
  const queueView = new QueueView(
    document.getElementById("queue-view")!,
    controller,
  );

  // Vis-mode label that flashes in the corner of the face screen on change.
  function flashVisLabel(text: string) {
    const el = document.getElementById("vis-mode-label")!;
    el.textContent = text;
    el.classList.remove("show");
    // Force reflow so the animation restarts even if the same label fires twice.
    void el.offsetWidth;
    el.classList.add("show");
  }

  // Long-form status overlay (full message visible, doesn't truncate).
  const statusOverlay = document.getElementById("status-overlay")!;
  const statusTitle = document.getElementById("so-title")!;
  const statusBody = document.getElementById("so-body")!;
  const statusActions = document.getElementById("so-actions")!;
  let statusHideTimer: number | null = null;

  interface StatusAction {
    label: string;
    primary?: boolean;
    onClick: () => void | Promise<void>;
  }

  function showStatus(
    title: string,
    body: string,
    opts: { durationMs?: number; actions?: StatusAction[] } = {},
  ) {
    statusTitle.textContent = title;
    statusBody.textContent = body;
    statusActions.innerHTML = "";
    for (const a of opts.actions ?? []) {
      const b = document.createElement("button");
      if (a.primary) b.className = "primary";
      b.textContent = a.label;
      b.addEventListener("click", () => void a.onClick());
      statusActions.appendChild(b);
    }
    if (!opts.actions?.length) {
      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", hideStatus);
      statusActions.appendChild(dismiss);
    }
    statusOverlay.classList.add("show");
    if (statusHideTimer) window.clearTimeout(statusHideTimer);
    const ms = opts.durationMs;
    if (ms !== undefined && ms > 0) {
      statusHideTimer = window.setTimeout(hideStatus, ms);
    }
  }

  function hideStatus() {
    if (statusHideTimer) window.clearTimeout(statusHideTimer);
    statusOverlay.classList.remove("show");
  }

  async function signOutAndReload() {
    await window.headspace.authSignOut();
    window.location.reload();
  }

  async function switchSpotifyAccount() {
    await window.headspace.authSignOut();
    showStatus(
      "Switch Spotify account",
      "Opening Spotify sign-in in your browser. If Spotify keeps selecting the same account, sign out at spotify.com in that browser and try again.",
      { durationMs: 7000 },
    );
    const result = await window.headspace.authSignIn({ showDialog: true });
    if (result.success) window.location.reload();
    else {
      showStatus("Sign-in failed", result.error ?? "Unknown error.", {
        durationMs: 7000,
      });
    }
  }

  async function renderSpotifySettings(container: HTMLElement) {
    container.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    const title = document.createElement("div");
    title.className = "settings-title";
    title.textContent = "Spotify";
    const body = document.createElement("div");
    body.className = "settings-body";
    const actions = document.createElement("div");
    actions.className = "settings-actions";
    panel.append(title, body, actions);
    container.appendChild(panel);

    const auth = await window.headspace.authStatus();
    if (!auth.authenticated) {
      body.textContent =
        "Not signed in.\n\nAdd SPOTIFY_CLIENT_ID to .env, then sign in with Spotify.\n\nRedirect URI:\nhttp://127.0.0.1:8888/callback";
      const signIn = document.createElement("button");
      signIn.className = "primary";
      signIn.textContent = "Sign in";
      signIn.addEventListener("click", async () => {
        const result = await window.headspace.authSignIn({ showDialog: true });
        if (result.success) window.location.reload();
        else showStatus("Sign-in failed", result.error ?? "Unknown error.");
      });
      actions.append(signIn);
      return;
    }

    let accountLine = "Signed in to Spotify.";
    const user = await window.headspace.spUser();
    if (user && typeof user === "object" && !("error" in user)) {
      const profile = user as { display_name?: string; email?: string; id?: string };
      const name = profile.display_name || profile.id || "Spotify user";
      accountLine = `Signed in as ${name}${profile.email ? `\n${profile.email}` : ""}.`;
    }

    body.textContent = accountLine;

    const switchBtn = document.createElement("button");
    switchBtn.className = "primary";
    switchBtn.textContent = "Switch";
    switchBtn.addEventListener("click", switchSpotifyAccount);
    const signOutBtn = document.createElement("button");
    signOutBtn.textContent = "Sign out";
    signOutBtn.addEventListener("click", signOutAndReload);
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", () => {
      void renderSpotifySettings(container);
    });
    actions.append(switchBtn, signOutBtn, refreshBtn);
  }

  const transport = await Transport.create(document.getElementById("transport")!, {
    onClick: (btn) => {
      if (btn === "play") void controller.togglePlay();
      else if (btn === "stop") void controller.togglePlay(); // No real "stop" in Spotify
      else if (btn === "next") void controller.next();
      else if (btn === "prev") void controller.previous();
      else if (btn === "vis") {
        const next = viz.cycleMode();
        flashVisLabel(Visualizer.labelFor(next));
      }
    },
  });
  void transport;
  void VIS_MODES;

  // Show current mode briefly on startup so user knows what they're seeing.
  flashVisLabel(Visualizer.labelFor(viz.getMode()));

  // Library browser populated only after auth.
  const drawerBody = document.getElementById("pl-drawer-body")!;
  let library: LibraryBrowser | null = null;

  // ---------- Volume + Balance sliders (left "EQ" drawer) ----------
  const storedVolume = parseFloat(localStorage.getItem(STORAGE_KEYS.volume) ?? "");
  const initialVolume = Number.isFinite(storedVolume) ? storedVolume : 0.85;

  const volumeSlot = document.getElementById("slot-volume-spotify")!;
  const volumeSlider = new SkinSlider({
    orientation: "horizontal",
    min: 0,
    max: 1,
    value: initialVolume,
    width: 140,
    height: 12,
    onChange: (v) => {
      localStorage.setItem(STORAGE_KEYS.volume, v.toFixed(3));
      void controller.setVolume(v);
    },
  });
  volumeSlot.appendChild(volumeSlider.el);
  // Apply persisted volume to the SDK as soon as it becomes ready.
  let appliedInitialVolume = false;

  const storedBalance = parseFloat(localStorage.getItem(STORAGE_KEYS.balance) ?? "0");
  const initialBalance = Number.isFinite(storedBalance) ? storedBalance : 0;
  const balanceSlot = document.getElementById("slot-balance-spotify")!;
  const balanceNote = document.getElementById("qd-balance-note")!;
  const balanceSlider = new SkinSlider({
    orientation: "horizontal",
    min: -1,
    max: 1,
    value: initialBalance,
    width: 140,
    height: 12,
    detent: 0,
    onChange: (v) => {
      localStorage.setItem(STORAGE_KEYS.balance, v.toFixed(3));
      liveAudio.setPan(v);
    },
  });
  balanceSlot.appendChild(balanceSlider.el);
  // Balance only works when the audio-element tap path is active. With
  // loopback or synthetic, we can't intercept playback — the slider stays
  // disabled and shows a small note explaining why.
  function refreshBalanceAvailability() {
    const can = liveAudio.canPan();
    balanceSlider.setEnabled(can);
    balanceNote.textContent = can ? "" : "(unavailable — DRM)";
    if (can) liveAudio.setPan(balanceSlider.getValue());
  }
  refreshBalanceAvailability();

  // Subscribe to controller state — drives now-playing, art, seek, pause overlay,
  // and feeds visualizer the current playback position + analysis on track change.
  let lastTrackId: string | null = null;
  let trackChangeToken = 0; // race guard for any per-track async work
  let lastIsPlaying: boolean | null = null;
  // Cache the seek-fill element so we don't re-query the DOM every state tick.
  const seekFill = document.getElementById("seek-fill") as HTMLDivElement;

  controller.on((s: SpotifyState) => {
    queueView.handleState(s);
    if (s.track) {
      const artistNames = s.track.artists.map((a) => a.name).join(", ");
      nowPlaying.textContent = `${artistNames} — ${s.track.name}`;
      if (s.track.id !== lastTrackId) {
        lastTrackId = s.track.id;
        // Single token guards every per-track async fetch (palette + analysis).
        // If the user skips tracks rapidly, late-arriving promises for old
        // tracks are dropped instead of overwriting the current track's data.
        const token = ++trackChangeToken;
        const url = s.track.album.images[0]?.url ?? null;
        viz.setCoverArt(url);
        if (url) {
          void extractPalette(url).then((p) => {
            if (token !== trackChangeToken) return; // stale — user skipped
            viz.setPalette(p);
            setAutoThemeHue(p.primaryHueDeg);
          });
        } else {
          viz.setPalette(DEFAULT_PALETTE);
          setAutoThemeHue(95); // lime default
        }
        // Reset lyrics for the new track. Fetch only if user wants them.
        currentLyrics = null;
        lyricsTrackId = null;
        lastRenderedLineIdx = -2;
        if (lyricsEnabled) void loadLyricsForCurrentTrack();
        refreshLyricsButton();
        // Fetch fresh audio analysis for beat-synced modes.
        viz.setAnalysis(null);
        const trackDuration = s.track.duration_ms;
        void window.headspace.spAnalysis(s.track.id).then((res) => {
          if (token !== trackChangeToken) return; // stale
          if (res && typeof res === "object" && !("error" in (res as object))) {
            viz.setAnalysis(res as never);
          } else {
            // Spotify killed /audio-analysis access for new apps in Nov 2024.
            // Fall back to a synthetic 120-BPM analysis so the visualizers
            // animate (not actually beat-synced to the song).
            viz.setAnalysis(buildSyntheticAnalysis(trackDuration) as never);
          }
        });
      }
    } else {
      nowPlaying.textContent = "— signed in, awaiting playback —";
    }
    viz.setPlaying(s.isPlaying);
    viz.setPosition(s.positionMs);
    tickLyrics(s.positionMs);
    // Skip DOM write when the playing flag hasn't actually changed; the state
    // tick fires several times a second and DOM writes trigger style recalc.
    if (s.isPlaying !== lastIsPlaying) {
      lastIsPlaying = s.isPlaying;
      if (s.isPlaying) pauseOverlay.removeAttribute("hidden");
      else pauseOverlay.setAttribute("hidden", "");
    }
    if (s.durationMs > 0) {
      seekFill.style.width = `${Math.min(100, (s.positionMs / s.durationMs) * 100)}%`;
    } else {
      seekFill.style.width = "0%";
    }
  });

  // Seek slider — click anywhere on the track to jump
  const seek = document.getElementById("seek-track")!;
  seek.addEventListener("click", (e) => {
    const r = seek.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    const dur = controller.state().durationMs;
    if (dur > 0) void controller.seek(pct * dur);
  });

  // Once authed, init the controller (SDK first, Connect fallback) and library.
  let initialized = false;

  async function tryInitController() {
    nowPlaying.textContent = "Connecting to Spotify…";
    const result = await controller.init();
    if (result.mode === "sdk") {
      hideStatus();
      nowPlaying.textContent = "Ready. Pick a track from the playlist drawer.";
      // Apply the persisted volume to the SDK so the slider's position
      // reflects what's actually playing.
      if (!appliedInitialVolume) {
        appliedInitialVolume = true;
        void controller.setVolume(volumeSlider.getValue());
      }
      // Probe live audio. Tap usually fails under DRM, but try anyway —
      // it's free. If it fails, user can press Ctrl+L to enable loopback.
      void tryEnableLiveAudio();
    } else if (result.mode === "connect") {
      nowPlaying.textContent =
        "Connect mode — open Spotify on a device, then pick a track.";
      console.warn("[headspace] SDK init failed:", result.error);
      // Pull diag info so the user can see whether Widevine actually loaded.
      const diag = (await window.headspace.systemDiag()) as {
        electronVersion: string;
        chromeVersion: string;
        components?: unknown;
      };
      const widevine =
        diag?.components && typeof diag.components === "object"
          ? JSON.stringify(diag.components)
          : "no info";
      const widevineFailed =
        widevine.includes("error") || widevine === "no info" || widevine === "{}";
      showStatus(
        widevineFailed ? "Widevine install failed" : "In-app playback unavailable",
        widevineFailed
          ? `Spotify needs Widevine DRM to stream in-app, but the install failed:\n\n${widevine}\n\nLikely causes: Windows Defender / antivirus blocking the download, or a stuck partial install. Reset wipes the cache and retries cleanly.`
          : `SDK error: ${result.error ?? "unknown"}\n\nElectron ${diag?.electronVersion} (Chromium ${diag?.chromeVersion})\nWidevine: ${widevine}\n\nFalling back to Connect mode.`,
        {
          durationMs: 0,
          actions: widevineFailed
            ? [
                {
                  label: "Reset & Retry",
                  primary: true,
                  onClick: async () => {
                    showStatus(
                      "Resetting Widevine…",
                      "Clearing cached components and reinstalling. This can take 30–60 seconds.",
                      { durationMs: 0 },
                    );
                    const r = (await window.headspace.systemResetWidevine()) as {
                      removed: string[];
                      components: unknown;
                    };
                    console.log("[headspace] reset result:", r);
                    showStatus(
                      "Retrying SDK…",
                      "Component cache rebuilt. Re-initializing playback…",
                      { durationMs: 0 },
                    );
                    await tryInitController();
                  },
                },
                { label: "Use Connect", onClick: hideStatus },
              ]
            : [
                {
                  label: "Retry SDK",
                  primary: true,
                  onClick: async () => {
                    showStatus(
                      "Retrying…",
                      "Re-initializing Spotify Web Playback SDK… (up to 15s)",
                      { durationMs: 0 },
                    );
                    await tryInitController();
                  },
                },
                { label: "Use Connect", onClick: hideStatus },
              ],
        },
      );
    }
  }

  async function onAuthed() {
    if (initialized) {
      // If user signs back in after a logout, the SDK might now succeed.
      void tryInitController();
      return;
    }
    initialized = true;
    await tryInitController();
    void queueView.refresh();

    library = new LibraryBrowser(drawerBody, controller, {
      renderSettings: renderSpotifySettings,
    });
    library.setErrorHandler((err) => {
      if (err === "no_device") {
        showStatus(
          "No active Spotify device",
          "Open the Spotify app on your phone, desktop, or web player. As soon as it's open, click the track here again.",
          { durationMs: 8000 },
        );
      } else {
        showStatus("Playback error", err, { durationMs: 6000 });
      }
    });
    void library;
    setTimeout(() => skin.togglePlaylist(), 600);
  }

  wireSpotifyAuth(onAuthed);

  console.log(
    "[headspace] v2 ready · Space=play/pause · Esc=quit · Ctrl+T=on-top · Ctrl+D=mask · Ctrl+L=live audio",
  );
})();

/** Replaces the EQ panel grid with Volume + Balance sliders + Queue placeholder. */
function setupQueueDrawerStub() {
  const panel = document.getElementById("eq-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="qd-section">
      <div class="qd-label">Volume</div>
      <div id="slot-volume-spotify"></div>
    </div>
    <div class="qd-section">
      <div class="qd-label">Balance <span id="qd-balance-note" class="qd-sub-note"></span></div>
      <div id="slot-balance-spotify"></div>
    </div>
    <div class="qd-section qd-queue">
      <div id="queue-view"></div>
    </div>
  `;
}
