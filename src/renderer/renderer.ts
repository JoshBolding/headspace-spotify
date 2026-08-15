/**
 * Spotify-edition renderer entry.
 *
 * Thin bootstrap: hit-test, skin chrome, Spotify controller, and the
 * feature modules that used to live in this file. Behavior is unchanged;
 * the split is so the next person doesn't have to scroll 1400 lines to
 * find the lyrics toggle.
 */

import { Visualizer } from "./visualizer";
import { ButterchurnViz } from "./butterchurn-viz";
import { AudioHud } from "./audio-hud";
import { SkinState } from "./skin-state";
import { Transport } from "./transport";
import { SkinSlider } from "./skin-slider";
import { SpotifyController } from "./spotify-player";
import { LibraryBrowser } from "./library-browser";
import { LiveAudio } from "./live-audio";
import { STORAGE_KEYS } from "./storage-keys";
import { FaceAlive, NOSE_CLICKS_REQUIRED } from "./face-alive";
import { attachMediaSession } from "./media-session";
import { QueueView } from "./queue-view";
import { initHitTest } from "./hit-test";
import { wireSpotifyAuth } from "./auth-flow";
import { StatusOverlay } from "./status-overlay";
import { LyricsPanel } from "./lyrics-panel";
import { wireVisMenu } from "./vis-menu";
import { MilkdropDriver } from "./milkdrop-driver";
import { wireNowPlaying } from "./now-playing";
import {
  createSettingsRenderer,
  renderRuntimeDiagnostics,
  summarizeWidevineDiag,
} from "./settings-panel";
import { ThemeCycler } from "./theme-cycler";
import { MiniMode } from "./mini-mode";
import { flashVisLabel } from "./vis-label";
import { getVizAudioMode } from "./viz-audio-pref";
import { wireLikeButton } from "./like-button";
import { wirePlaybackChrome } from "./playback-chrome";
import { wireSeekBar } from "./seek-bar";

function wireKeys(controller: SpotifyController, faceAlive?: FaceAlive): void {
  const faceAliveDebugEnabled =
    import.meta.env.DEV ||
    new URLSearchParams(window.location.search).has("faceDebug") ||
    localStorage.getItem("faceAliveDebug") === "1";
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "d")
      document.body.classList.toggle("debug");
    if (
      !e.ctrlKey &&
      e.key.toLowerCase() === "d" &&
      faceAliveDebugEnabled &&
      faceAlive?.isActive()
    ) {
      e.preventDefault();
      faceAlive.toggleDebugOverlay();
    }
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

/** Replaces the EQ panel grid with Volume + Balance sliders + Queue placeholder. */
function setupQueueDrawerStub() {
  const panel = document.getElementById("eq-panel");
  if (!panel) return;
  panel.innerHTML = `
    <div class="qd-section qd-volume">
      <div class="qd-label">Volume</div>
      <div id="slot-volume-spotify"></div>
    </div>
    <div class="qd-section qd-now">
      <div class="qd-label">Now Playing</div>
      <div id="left-now-view" class="qd-now-card">
        <div class="qd-now-art"></div>
        <div class="qd-now-text">
          <div class="qd-now-title">Awaiting playback</div>
          <div class="qd-now-sub">Pick a track from the right ear</div>
        </div>
      </div>
    </div>
    <div class="qd-section qd-queue">
      <div id="queue-view"></div>
    </div>
    <div class="qd-balance-advanced">
      <span id="qd-balance-note" class="qd-sub-note"></span>
      <div id="slot-balance-spotify"></div>
    </div>
  `;
}

(async () => {
  await initHitTest();

  const vizCanvas = document.getElementById("vis-canvas") as HTMLCanvasElement;
  const viz = new Visualizer(vizCanvas);
  const liveAudio = new LiveAudio();

  const bcCanvas = document.getElementById("butterchurn-canvas") as HTMLCanvasElement;
  const bcViz = new ButterchurnViz(bcCanvas);
  const milkdrop = new MilkdropDriver(bcViz, liveAudio);

  const audioHud = new AudioHud(document.getElementById("stage") ?? document.body);
  audioHud.setLiveAudio(liveAudio);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      audioHud.toggle();
    }
  });

  const theme = new ThemeCycler(flashVisLabel);

  // ---------- Easter-egg: alive-face mode ----------
  // 5 left-clicks on the nose hitbox within 2s toggles the head's "alive"
  // mode (eyes open + glow, ears throb to beat, head sways/bobs). Hidden
  // from any visible UI — discoverable only by playing with it.
  const faceAlive = new FaceAlive();
  window.__faceAlive = faceAlive.getDebugApi();
  faceAlive.restorePersisted();
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
    } else if (faceAlive.isActive()) {
      // Already awake: a poke on the nose makes him blink and glance over.
      // (Five quick pokes within the window still toggles back to sleep.)
      faceAlive.boop();
    }
  });

  /**
   * Default is Spotify-only: tap the in-app <audio> element. Loopback hears
   * YouTube/Discord/everything, so it stays opt-in (right-click vis → Audio).
   */
  async function tryEnableLiveAudio(): Promise<void> {
    const wantSystem = getVizAudioMode() === "system";
    const have = liveAudio.getSource();
    if (have === "tap") return;
    if (have === "loopback" && wantSystem) return;
    if (have === "loopback" && !wantSystem) {
      liveAudio.stop();
      viz.setLiveAudio(null);
      faceAlive.setLiveAudio(null);
    }
    if (await liveAudio.tryTap()) {
      viz.setLiveAudio(liveAudio);
      faceAlive.setLiveAudio(liveAudio);
      refreshBalanceAvailability();
      void milkdrop.applyVisModeUI(viz.getMode());
      console.log("[viz] live audio: Spotify tap");
      return;
    }
    if (wantSystem && (await liveAudio.tryLoopback())) {
      viz.setLiveAudio(liveAudio);
      faceAlive.setLiveAudio(liveAudio);
      refreshBalanceAvailability();
      void milkdrop.applyVisModeUI(viz.getMode());
      console.log("[viz] live audio: system mix (all apps)");
      return;
    }
    refreshBalanceAvailability();
    console.warn(
      wantSystem
        ? "[viz] no live audio — synthetic fallback. Ctrl+L to retry."
        : "[viz] Spotify-only mode: in-app tap silent (DRM) or Connect playback. Right-click vis → Audio → All system audio if you want the Windows mix.",
    );
  }

  async function reconnectLiveAudio(diagContainer?: HTMLElement): Promise<void> {
    liveAudio.stop();
    viz.setLiveAudio(null);
    faceAlive.setLiveAudio(null);
    refreshBalanceAvailability();
    await tryEnableLiveAudio();
    if (diagContainer) await renderRuntimeDiagnostics(diagContainer, controller, liveAudio);
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      void reconnectLiveAudio();
    }
  });

  setupQueueDrawerStub();

  const skin = new SkinState({
    plEar: document.getElementById("pl-ear")!,
    eqEar: document.getElementById("eq-ear")!,
    plHandle: document.getElementById("btn-pl-handle")!,
    eqHandle: document.getElementById("btn-eq-handle")!,
  });
  const mini = new MiniMode(skin);

  document.getElementById("btn-pl-handle")!.addEventListener("click", () => {
    mini.exitForDrawer();
    skin.togglePlaylist();
  });
  document.getElementById("btn-pl-open")!.addEventListener("click", () => {
    mini.exitForDrawer();
    skin.togglePlaylist();
  });
  document.getElementById("btn-eq-handle")!.addEventListener("click", () => {
    mini.exitForDrawer();
    skin.toggleEq();
  });
  document.getElementById("btn-eq-open")!.addEventListener("click", () => {
    mini.exitForDrawer();
    skin.toggleEq();
  });

  document
    .getElementById("btn-minimize")!
    .addEventListener("click", () => window.headspace.minimize());
  document
    .getElementById("btn-close")!
    .addEventListener("click", () => window.headspace.close());

  const nowPlaying = document.getElementById("now-playing")!;
  const controller = new SpotifyController();
  wireKeys(controller, faceAlive);
  attachMediaSession(controller);
  const queueView = new QueueView(document.getElementById("queue-view")!, controller);
  const lyrics = new LyricsPanel(controller);
  const status = new StatusOverlay();
  const seek = wireSeekBar(controller, status);

  wireVisMenu(viz, milkdrop, () => {
    void reconnectLiveAudio();
  });
  wireLikeButton(controller, status, faceAlive);
  wirePlaybackChrome(controller, status);
  wireNowPlaying({
    controller,
    viz,
    faceAlive,
    queueView,
    lyrics,
    theme,
    isScrubbing: seek.isScrubbing,
    onPlaying: (playing) => {
      if (playing && !liveAudio.getSource()) void tryEnableLiveAudio();
    },
  });

  const renderSpotifySettings = createSettingsRenderer({
    controller,
    liveAudio,
    status,
    tryInitController,
    reconnectLiveAudio,
  });

  await Transport.create(document.getElementById("transport")!, {
    onClick: (btn) => {
      if (btn === "play") {
        void status.runPlaybackCommand(controller, "Play", () => controller.togglePlay());
      } else if (btn === "stop") {
        void status.runPlaybackCommand(controller, "Pause", () => controller.togglePlay());
      } else if (btn === "next") {
        void status.runPlaybackCommand(controller, "Next", () => controller.next());
        faceAlive.notifySkip(1);
      } else if (btn === "prev") {
        void status.runPlaybackCommand(controller, "Previous", () => controller.previous());
        faceAlive.notifySkip(-1);
      } else if (btn === "vis") {
        const next = viz.cycleMode();
        flashVisLabel(Visualizer.labelFor(next));
        void milkdrop.applyVisModeUI(next);
      }
    },
  });

  flashVisLabel(Visualizer.labelFor(viz.getMode()));
  void milkdrop.applyVisModeUI(viz.getMode());

  const drawerBody = document.getElementById("pl-drawer-body")!;
  let library: LibraryBrowser | null = null;

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

  function refreshBalanceAvailability() {
    const can = liveAudio.canPan();
    balanceSlider.setEnabled(can);
    balanceNote.textContent = can ? "" : "(unavailable — DRM)";
    if (can) liveAudio.setPan(balanceSlider.getValue());
  }
  refreshBalanceAvailability();

  let initialized = false;

  async function tryInitController() {
    nowPlaying.textContent = "Connecting to Spotify...";
    const result = await controller.init();
    if (result.mode === "sdk") {
      status.hide();
      nowPlaying.textContent = "Ready. Pick a track from the playlist drawer.";
      if (!appliedInitialVolume) {
        appliedInitialVolume = true;
        void controller.setVolume(volumeSlider.getValue());
      }
      void tryEnableLiveAudio();
    } else if (result.mode === "connect") {
      nowPlaying.textContent =
        "Connect mode — open Spotify on a device, then pick a track.";
      void tryEnableLiveAudio();
      console.warn("[headspace] SDK init failed:", result.error);
      const diag = await window.headspace.systemDiag();
      const componentSummary = summarizeWidevineDiag(diag.components);
      const widevineFailed = componentSummary.failed;
      const sdkError = result.error ?? "unknown";
      status.show(
        widevineFailed ? "Widevine install failed" : "In-app playback unavailable",
        widevineFailed
          ? `Spotify needs Widevine DRM to stream in-app, but the component setup failed:\n\n${componentSummary.text}\n\nLikely causes: Windows Defender / antivirus blocking the download, or a stuck partial install. Reset wipes the cache and retries cleanly.`
          : `SDK error: ${sdkError}\n\nElectron ${diag?.electronVersion} (Chromium ${diag?.chromeVersion})\nWidevine: ${componentSummary.text}\n\nFalling back to Connect mode.`,
        {
          durationMs: 0,
          actions: widevineFailed
            ? [
                {
                  label: "Reset & Retry",
                  primary: true,
                  onClick: async () => {
                    status.show(
                      "Resetting Widevine...",
                      "Clearing cached components and reinstalling. This can take 30–60 seconds.",
                      { durationMs: 0 },
                    );
                    const r = await window.headspace.systemResetWidevine();
                    console.log("[headspace] reset result:", r);
                    status.show(
                      "Retrying SDK...",
                      "Component cache rebuilt. Re-initializing playback...",
                      { durationMs: 0 },
                    );
                    await tryInitController();
                  },
                },
                { label: "Use Connect", onClick: () => status.hide() },
              ]
            : [
                {
                  label: "Retry SDK",
                  primary: true,
                  onClick: async () => {
                    status.show(
                      "Retrying...",
                      "Re-initializing Spotify Web Playback SDK... (up to 15s)",
                      { durationMs: 0 },
                    );
                    await tryInitController();
                  },
                },
                { label: "Use Connect", onClick: () => status.hide() },
              ],
        },
      );
    }
  }

  async function onAuthed() {
    if (initialized) {
      void tryInitController();
      return;
    }
    initialized = true;
    await tryInitController();
    void queueView.refresh();

    library = new LibraryBrowser(drawerBody, controller, {
      renderSettings: renderSpotifySettings,
      onQueued: () => {
        void queueView.refresh();
        window.setTimeout(() => void queueView.refresh(), 900);
      },
    });
    library.setErrorHandler((err) => {
      status.showPlaybackError(err);
    });
    queueView.setErrorHandler((err) => status.showPlaybackError(err));
    setTimeout(() => skin.togglePlaylist(), 600);
  }

  wireSpotifyAuth(onAuthed);

  console.log(
    "[headspace] v2 ready · Space=play/pause · Esc=quit · Ctrl+T=on-top · Ctrl+D=mask · Ctrl+L=live audio",
  );
})();
