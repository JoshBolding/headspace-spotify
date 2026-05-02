/**
 * Spotify Web Playback SDK wrapper.
 *
 * Initializes the SDK as a Connect device named "Headspace", exposes a clean
 * API for the rest of the app, and falls back to Connect-only remote-control
 * mode if the SDK can't init (free-tier accounts get an `account_error`).
 *
 * SDK reference: https://developer.spotify.com/documentation/web-playback-sdk
 */

interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string; uri: string }[];
  album: { name: string; uri: string; images: { url: string }[] };
}

export interface SpotifyState {
  track: SpotifyTrack | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
}

declare global {
  interface Window {
    Spotify?: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume: number;
      }) => SpotifyPlayerInstance;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

interface SpotifyPlayerInstance {
  connect(): Promise<boolean>;
  disconnect(): void;
  togglePlay(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getCurrentState(): Promise<RawSdkState | null>;
  addListener(event: string, cb: (...args: unknown[]) => void): boolean;
  activateElement(): Promise<void>;
}

interface RawSdkState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: SpotifyTrack };
}

export type Mode = "sdk" | "connect" | "uninitialized";

type Listener = (s: SpotifyState) => void;

export class SpotifyController {
  private player: SpotifyPlayerInstance | null = null;
  private deviceId: string | null = null;
  private mode: Mode = "uninitialized";
  private listeners = new Set<Listener>();
  private connectPollHandle: number | null = null;
  private lastState: SpotifyState = {
    track: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
  };
  private localPositionStartedAt = 0;
  private localPositionBaseMs = 0;
  private positionRafHandle: number | null = null;

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  state(): SpotifyState {
    return this.lastState;
  }

  getMode(): Mode {
    return this.mode;
  }

  getDeviceId(): string | null {
    return this.deviceId;
  }

  /** Try SDK first; fall back to Connect mode on Premium failure. */
  async init(): Promise<{ mode: Mode; error?: string }> {
    const sdkResult = await this.tryInitSdk();
    if (sdkResult.ok) {
      this.mode = "sdk";
      if (this.connectPollHandle !== null) {
        window.clearInterval(this.connectPollHandle);
        this.connectPollHandle = null;
      }
      this.startLocalPositionTicker();
      return { mode: "sdk" };
    }
    if (this.mode !== "connect") {
      this.mode = "connect";
      this.startConnectPolling();
    }
    return { mode: "connect", error: sdkResult.error };
  }

  /** Try SDK init again — useful after Widevine finishes downloading or token refresh. */
  async retryInit(): Promise<{ mode: Mode; error?: string }> {
    return this.init();
  }

  private async tryInitSdk(): Promise<{ ok: true } | { ok: false; error: string }> {
    await loadSdkScript();
    if (!window.Spotify?.Player) {
      return { ok: false, error: "sdk_unavailable" };
    }

    const player = new window.Spotify.Player({
      name: "Headspace",
      getOAuthToken: (cb) => {
        console.log("[spotify] SDK requesting OAuth token");
        void window.headspace
          .authGetToken()
          .then((t) => {
            if (t) {
              console.log("[spotify] SDK got token");
              cb(t);
            } else {
              console.warn("[spotify] SDK requested token but got null");
              cb(""); // Let SDK fail with auth error rather than hang
            }
          })
          .catch((err) => {
            console.error("[spotify] SDK token fetch failed:", err);
            cb("");
          });
      },
      volume: 0.85,
    });

    let ready = false;
    let initError: string | null = null;

    player.addListener("ready", (...args) => {
      const evt = args[0] as { device_id: string };
      console.log("[spotify] SDK ready, device_id:", evt.device_id);
      this.deviceId = evt.device_id;
      ready = true;
    });
    player.addListener("not_ready", (...args) => {
      const evt = args[0] as { device_id: string };
      console.warn("[spotify] SDK not_ready:", evt.device_id);
      this.deviceId = null;
    });
    player.addListener("initialization_error", (...args) => {
      const evt = args[0] as { message: string };
      console.error("[spotify] init error:", evt.message);
      initError = `init: ${evt.message}`;
    });
    player.addListener("authentication_error", (...args) => {
      const evt = args[0] as { message: string };
      console.error("[spotify] auth error:", evt.message);
      initError = `auth: ${evt.message}`;
    });
    player.addListener("account_error", (...args) => {
      const evt = args[0] as { message: string };
      console.error("[spotify] account error:", evt.message);
      initError = `account: ${evt.message} (Premium required)`;
    });
    player.addListener("playback_error", (...args) => {
      const evt = args[0] as { message: string };
      console.warn("[spotify] playback error:", evt.message);
    });
    player.addListener("player_state_changed", (...args) => {
      const raw = args[0] as RawSdkState | null;
      this.handleSdkState(raw);
    });

    console.log("[spotify] calling player.connect()");
    const connected = await player.connect();
    console.log("[spotify] connect() returned:", connected);
    if (!connected) {
      return { ok: false, error: initError || "connect_failed" };
    }

    // Bumped to 15s because Widevine + device registration on first launch
    // can take ~5-10s; previous 4s budget timed out before the ready event.
    const start = Date.now();
    const TIMEOUT = 15000;
    while (!ready && !initError && Date.now() - start < TIMEOUT) {
      await sleep(120);
    }

    if (initError) {
      try {
        player.disconnect();
      } catch {
        /* ignore */
      }
      return { ok: false, error: initError };
    }
    if (!ready) {
      try {
        player.disconnect();
      } catch {
        /* ignore */
      }
      return { ok: false, error: "ready_timeout" };
    }

    // Tell the SDK its <audio> element can play without a per-call user gesture.
    // Without this, Electron's autoplay policy can silently abort playback after
    // the first "user gesture" expires.
    try {
      await player.activateElement();
      console.log("[spotify] activateElement() succeeded");
    } catch (err) {
      console.warn("[spotify] activateElement() failed:", err);
    }

    this.player = player;
    return { ok: true };
  }

  private handleSdkState(raw: RawSdkState | null) {
    if (!raw) {
      // Player became inactive (focus stolen by another device).
      this.lastState = { ...this.lastState, isPlaying: false };
      this.emit();
      return;
    }
    this.lastState = {
      track: raw.track_window.current_track,
      isPlaying: !raw.paused,
      positionMs: raw.position,
      durationMs: raw.duration,
    };
    this.localPositionBaseMs = raw.position;
    this.localPositionStartedAt = performance.now();
    this.emit();
  }

  /** Drive a smooth `positionMs` between SDK state events. Cancels any prior
   *  loop before starting a new one — `init()` may be called more than once
   *  (e.g. retry after Widevine load), and we don't want orphan RAFs accumulating. */
  private startLocalPositionTicker() {
    if (this.positionRafHandle !== null) {
      cancelAnimationFrame(this.positionRafHandle);
      this.positionRafHandle = null;
    }
    const tick = () => {
      if (this.lastState.isPlaying && this.localPositionStartedAt) {
        const elapsed = performance.now() - this.localPositionStartedAt;
        const positionMs = Math.min(
          this.localPositionBaseMs + elapsed,
          this.lastState.durationMs || Infinity,
        );
        if (Math.abs(positionMs - this.lastState.positionMs) > 200) {
          this.lastState = { ...this.lastState, positionMs };
          this.emit();
        }
      }
      this.positionRafHandle = requestAnimationFrame(tick);
    };
    this.positionRafHandle = requestAnimationFrame(tick);
  }

  private startConnectPolling() {
    const poll = async () => {
      try {
        const r = (await window.headspace.spState()) as
          | { item?: SpotifyTrack; is_playing: boolean; progress_ms: number }
          | { error: string }
          | null;
        if (r && !("error" in r) && r.item) {
          this.lastState = {
            track: r.item,
            isPlaying: r.is_playing,
            positionMs: r.progress_ms || 0,
            durationMs: r.item.duration_ms,
          };
          this.emit();
        }
      } catch {
        /* ignore */
      }
    };
    void poll();
    this.connectPollHandle = window.setInterval(poll, 2500);
  }

  private emit() {
    this.listeners.forEach((l) => l(this.lastState));
  }

  // -------- public playback methods --------

  /**
   * Make sure we have a device to send commands to. SDK mode always has one.
   * Connect mode needs an *active* device — Spotify rejects play attempts on
   * dormant devices with a 404. We refuse to try in that case so the user
   * gets a clear "open Spotify on a device" message instead of a confusing 404.
   */
  private async ensureDeviceId(): Promise<string | null> {
    if (this.deviceId) return this.deviceId;
    const result = (await window.headspace.spDevices()) as
      | Array<{
          id: string;
          name: string;
          type: string;
          is_active: boolean;
          is_restricted: boolean;
        }>
      | { error: string };
    if (!Array.isArray(result) || !result.length) return null;
    const active = result.find((d) => d.is_active && !d.is_restricted);
    if (active) {
      this.deviceId = active.id;
      return active.id;
    }
    return null;
  }

  /**
   * Make sure the SDK is the currently-active Connect device before issuing a
   * play command. Without this, another phantom-active device on the account
   * (a phone in your pocket, a desktop client running in the tray, an Echo)
   * keeps reclaiming playback and the SDK pauses ~1s after every start.
   *
   * Idempotent: if the SDK already has the active spot, this is a no-op.
   */
  private async ensureSdkIsActive(): Promise<void> {
    if (!this.player || !this.deviceId) return;
    try {
      const state = (await window.headspace.spState()) as
        | { device?: { id?: string } }
        | { error: string }
        | null;
      const activeId =
        state && !("error" in state) ? state.device?.id : undefined;
      if (activeId === this.deviceId) {
        console.log("[spotify] SDK already active");
        return;
      }
      console.log(
        "[spotify] transferring playback to SDK device (was:",
        activeId ?? "none",
        ")",
      );
      await window.headspace.spTransfer(this.deviceId, false);
      // Give Spotify ~600ms to propagate the transfer through the account
      // state-sync before we issue the play command. Empirically this
      // eliminates the pause-fight in our testing.
      await sleep(600);
    } catch (err) {
      console.warn("[spotify] ensureSdkIsActive failed:", err);
    }
  }

  async playTrack(
    uri: string,
    contextUri?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deviceId = await this.ensureDeviceId();
    if (!deviceId) return { ok: false, error: "no_device" };
    await this.ensureSdkIsActive();
    const opts: Record<string, unknown> = { deviceId };
    if (contextUri) {
      opts.contextUri = contextUri;
      opts.offsetUri = uri;
    } else {
      opts.uris = [uri];
    }
    console.log("[spotify] playTrack ->", opts);
    const r = await window.headspace.spPlay(opts);
    if (r && typeof r === "object" && "error" in (r as object)) {
      return { ok: false, error: (r as { error: string }).error };
    }
    return { ok: true };
  }

  async playContext(
    contextUri: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const deviceId = await this.ensureDeviceId();
    if (!deviceId) return { ok: false, error: "no_device" };
    await this.ensureSdkIsActive();
    console.log("[spotify] playContext ->", { deviceId, contextUri });
    const r = await window.headspace.spPlay({ deviceId, contextUri });
    if (r && typeof r === "object" && "error" in (r as object)) {
      return { ok: false, error: (r as { error: string }).error };
    }
    return { ok: true };
  }

  async togglePlay() {
    if (this.player) {
      await this.player.togglePlay();
      return;
    }
    if (this.lastState.isPlaying) {
      await window.headspace.spPause(this.deviceId ?? undefined);
    } else {
      await window.headspace.spPlay({ deviceId: this.deviceId ?? undefined });
    }
  }

  async next() {
    if (this.player) return this.player.nextTrack();
    await window.headspace.spNext(this.deviceId ?? undefined);
  }

  async previous() {
    if (this.player) return this.player.previousTrack();
    await window.headspace.spPrevious(this.deviceId ?? undefined);
  }

  async seek(positionMs: number) {
    if (this.player) return this.player.seek(positionMs);
    await window.headspace.spSeek(positionMs, this.deviceId ?? undefined);
  }

  async setVolume(volume0to1: number) {
    if (this.player) return this.player.setVolume(volume0to1);
    await window.headspace.spSetVolume(
      Math.round(volume0to1 * 100),
      this.deviceId ?? undefined,
    );
  }

  async addToQueue(uri: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const deviceId = await this.ensureDeviceId();
    if (!deviceId) return { ok: false, error: "no_device" };
    const r = await window.headspace.spAddQueue(uri, deviceId);
    if (r && typeof r === "object" && "error" in (r as object)) {
      return { ok: false, error: (r as { error: string }).error };
    }
    return { ok: true };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let sdkLoadPromise: Promise<void> | null = null;

function loadSdkScript(): Promise<void> {
  if (sdkLoadPromise) return sdkLoadPromise;
  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    if (window.Spotify?.Player) {
      resolve();
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.onerror = () => reject(new Error("Failed to load Spotify Web Playback SDK"));
    document.head.appendChild(s);
    setTimeout(() => {
      if (!window.Spotify?.Player) reject(new Error("SDK load timeout"));
    }, 10_000);
  });
  return sdkLoadPromise;
}
