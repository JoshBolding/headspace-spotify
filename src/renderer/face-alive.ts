/**
 * FaceAlive - Easter-egg "alive head" mode.
 *
 * When activated (5 clicks on the nose hitbox within 2 seconds, wired in
 * renderer.ts), the alien head comes to life:
 *  - Eyes open with a wake-up flourish, blink, track the mouse, idle-wander
 *  - Vestibulo-ocular reflex: head sway is subtracted from gaze so the eyes
 *    hold fixation while the head moves — a creature, not a wobbling image
 *  - Pupils dilate with the music and constrict on waking; gaze converges
 *    slightly on a near cursor
 *  - Speaker cones physically excurse on spectral-flux beats (SpeakerRig)
 *  - Big drop after a quiet stretch → eyes widen, pupils snap small, head jerks
 *  - Music paused → he gets drowsy and nods off; play → wakes with a flourish
 *  - Track change → curious reading glance; nose click while alive → boop
 *
 * Rendering lives in AliveEyeRig (procedural canvas eyes) and SpeakerRig
 * (sprite-sliced cones); this file is the motion brain.
 */

import type { LiveAudio } from "./live-audio";
import { AliveEyeRig, type EyeDrawState } from "./face-alive-eyes";
import { SpeakerRig, type BandLevels } from "./speaker-cones";

export const NOSE_CLICKS_REQUIRED = 5;

export type FaceAliveMode = "idle" | "tracking" | "saccade" | "blinking";

export interface FaceAlivePupilState {
  x: number;
  y: number;
}

export interface FaceAliveEyeState {
  leftOpenness: number;
  rightOpenness: number;
  leftPupil: FaceAlivePupilState;
  rightPupil: FaceAlivePupilState;
  mode: FaceAliveMode;
}

export interface FaceAliveDebugApi {
  getEyeState: () => FaceAliveEyeState;
  activate: () => void;
  deactivate: () => void;
  forceBlink: (delayMs?: number) => void;
  setDebugOverlay: (visible: boolean) => void;
  /** Test-only: drive the speaker cones with synthetic band energy so their
   *  excursion can be verified without a live audio source. */
  pumpCones: (bass: number, mid: number, high: number, beat: boolean) => void;
}

interface EyeTargets {
  left: FaceAlivePupilState;
  right: FaceAlivePupilState;
}

interface BlinkState {
  startAt: number;
  queuedAfter: number;
  forced: boolean;
}

interface SaccadeState {
  startAt: number;
  jumpMs: number;
  settleMs: number;
  from: EyeTargets;
  overshoot: EyeTargets;
  target: EyeTargets;
}

interface IdleDriftState {
  startAt: number;
  durationMs: number;
  from: FaceAlivePupilState;
  target: FaceAlivePupilState;
}

/** Scripted gaze sequence (wake-up, track glance, boop). */
interface GazeScript {
  startedAt: number;
  durationMs: number;
  steps: Array<{ at: number; x: number; y: number }>;
}

// Tuning. Alive mode should read immediately without shifting the skin layers.
const ACTIVATION_FLOURISH_MS = 1100;
const EYE_WAKE_OPEN_MS = 620;
const BAND_PEAK_DECAY = 0.992;

// Physiological blink timing. Closing is intentionally faster than opening.
const BLINK_INTERVAL_RANGE_MS = [2000, 6800] as const;
const BLINK_CLOSE_MS = 54;
const BLINK_HOLD_MS = 6;
const BLINK_OPEN_MS = 90;
const BLINK_DOUBLE_GAP_MS = 126;
const BLINK_MIN_OPENNESS = 0.03;
const DOUBLE_BLINK_CHANCE = 0.05;

// Eye motion limits are deliberately elliptical; horizontal travel is wider
// than vertical travel so the pupils stay inside the painted sockets. The
// downward limit is capped so the iris stays visible (cropped by the lower
// lid, "half eyeball") when looking down — beyond ~7px the iris center sinks
// below the lower lid and the eyeball vanishes into the socket.
const SOCKET_RADIUS_X = 20.5;
const EYE_MAX_UP_Y = 4.2;
const EYE_MAX_DOWN_Y = 7.0;
const EYE_GAZE_CENTER_Y_OFFSET = 10.5;
const PURSUIT_TIME_CONSTANT_MS = 70;
const IDLE_AFTER_MOUSE_MS = 500;
const WINDOW_RETURN_MS = 1000;
const IDLE_FIXATION_RANGE_X = 8.8;
const IDLE_FIXATION_RANGE_Y = 4.2;
const IDLE_TARGET_INTERVAL_RANGE_MS = [2000, 3600] as const;
const IDLE_DRIFT_DURATION_RANGE_MS = [110, 190] as const;
const IDLE_DESTINATION_BLINK_CHANCE = 0.3;
const THINKING_PATTERN_CHANCE = 0.12;
const SACCADE_DISTANCE_PX = 50;
const SACCADE_WINDOW_MS = 100;
const SACCADE_JUMP_RANGE_MS = [24, 52] as const;
const SACCADE_SETTLE_MS = 58;
const MICRO_JITTER_RANGE_PX = 1.65;
const MICRO_JITTER_INTERVAL_RANGE_MS = [80, 120] as const;

// Vestibulo-ocular reflex: fraction of head displacement counter-applied to
// the pupils so gaze stays world-fixed while the head sways.
const VOR_GAIN = 0.85;

// Vergence: how many px each eye rotates toward the nose for a near cursor.
const VERGENCE_MAX_PX = 2.2;
const VERGENCE_NEAR_PX = 230;

// Pupil dynamics.
const WAKE_CONSTRICT_SCALE = 0.76;
const WAKE_PUPIL_SETTLE_MS = 1700;
const BEAT_PUPIL_BUMP = 0.1;
const DROP_CONSTRICT_SCALE = 0.72;

// Sleep cycle. Only engages if music had actually been playing this session.
const DROWSE_AFTER_PAUSE_MS = 30_000;
const DROWSE_RAMP_MS = 18_000;
const DROWSE_WAKE_MS = 1_300;

const INITIAL_STATE: FaceAliveEyeState = {
  leftOpenness: BLINK_MIN_OPENNESS,
  rightOpenness: BLINK_MIN_OPENNESS,
  leftPupil: { x: 0, y: 0 },
  rightPupil: { x: 0, y: 0 },
  mode: "idle",
};

export class FaceAlive {
  private active = false;
  private liveAudio: LiveAudio | null = null;
  private rafHandle: number | null = null;
  private headEl: HTMLElement | null;
  private leftEarEl: HTMLElement | null;
  private rightEarEl: HTMLElement | null;
  private leftEarContainerEl: HTMLElement | null;
  private rightEarContainerEl: HTMLElement | null;
  private leftEyeEl: HTMLCanvasElement | null;
  private rightEyeEl: HTMLCanvasElement | null;
  private headLightEl: HTMLElement | null;
  private debugCanvasEl: HTMLCanvasElement | null;
  private rig: AliveEyeRig | null = null;
  private speakers: SpeakerRig | null = null;
  private assetsLoaded = false;

  // Smoothed audio state. The *Env set drives eye glow / head light (slow,
  // breathy); the cone* set drives the speakers (fast attack, slow release).
  private bassEnv = 0;
  private midEnv = 0;
  private highEnv = 0;
  private coneBass = 0;
  private coneMid = 0;
  private coneHigh = 0;
  private bassPeak = 0.18;
  private midPeak = 0.18;
  private highPeak = 0.18;

  private flourishMsLeft = 0;
  private startedAt = 0;
  private lastTickAt = 0;
  private nextBlinkAt = 0;
  private blink: BlinkState | null = null;
  private openness = BLINK_MIN_OPENNESS;

  private mouseX = 0;
  private mouseY = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMouseMoveAt = -Infinity;
  private lastPointerSampleAt = 0;
  private mouseInWindow = false;
  private windowLeftAt = -Infinity;
  private saccadeRequested = false;

  private leftPupil: FaceAlivePupilState = { x: 0, y: 0 };
  private rightPupil: FaceAlivePupilState = { x: 0, y: 0 };
  private saccade: SaccadeState | null = null;
  private idleFixation: FaceAlivePupilState = { x: 0, y: 0 };
  private idleDrift: IdleDriftState | null = null;
  private nextIdleTargetAt = 0;
  private idleThinkingUntil = 0;
  private microJitter: FaceAlivePupilState = { x: 0, y: 0 };
  private microJitterTarget: FaceAlivePupilState = { x: 0, y: 0 };
  private nextMicroJitterAt = 0;
  private lastState: FaceAliveEyeState = { ...INITIAL_STATE };
  private debugOverlayVisible = false;

  // Cached eye rects — getBoundingClientRect in the rAF loop forces layout.
  private leftEyeRect: DOMRect | null = null;
  private rightEyeRect: DOMRect | null = null;
  private eyeRectsCachedAt = -Infinity;

  // Behaviors.
  private script: GazeScript | null = null;
  private widen = 0;
  private pupilScale = 1;
  private pupilBump = 0;
  private squintUntil = 0;
  private headJerkPos = 0;
  private headJerkVel = 0;
  private isPlaying = false;
  private everPlayed = false;
  private pausedAt = -Infinity;
  private drowse = 0;
  private stirUntil = 0;
  private coneTestHoldUntil = 0; // test-only: hold pumped cone excursion
  private globalTracking = false; // main is polling the OS cursor for us
  private cursorUnsub: (() => void) | null = null;

  constructor() {
    // Transform the wrapper (head + eyes) so eyes stay pinned to the face
    // while the head breathes or tilts.
    this.headEl = document.getElementById("head-group");
    this.leftEarEl = document.querySelector("#eq-ear .ear-img");
    this.rightEarEl = document.querySelector("#pl-ear .ear-img");
    this.leftEarContainerEl = document.getElementById("eq-ear");
    this.rightEarContainerEl = document.getElementById("pl-ear");
    this.leftEyeEl = document.getElementById("alive-eye-left") as HTMLCanvasElement | null;
    this.rightEyeEl = document.getElementById("alive-eye-right") as HTMLCanvasElement | null;
    this.headLightEl = document.getElementById("alive-head-light");
    this.debugCanvasEl = document.getElementById("face-alive-debug") as HTMLCanvasElement | null;

    if (this.leftEyeEl && this.rightEyeEl) {
      this.rig = new AliveEyeRig(this.leftEyeEl, this.rightEyeEl);
    }
    if (this.leftEarContainerEl && this.rightEarContainerEl) {
      this.speakers = new SpeakerRig([
        { container: this.rightEarContainerEl, mirrored: false },
        { container: this.leftEarContainerEl, mirrored: true },
      ]);
    }
    // Load sprites in the background; activation before this resolves just
    // means the eyes fade in a beat later.
    void Promise.all([
      this.rig?.load() ?? Promise.resolve(),
      this.speakers?.load() ?? Promise.resolve(),
    ]).then(() => {
      this.assetsLoaded = true;
    });

    window.addEventListener("pointermove", this.handlePointerMove, { passive: true });
    document.addEventListener("mouseleave", this.handlePointerLeave, { passive: true });
    window.addEventListener("blur", this.handlePointerLeave, { passive: true });
    window.addEventListener("resize", () => {
      this.eyeRectsCachedAt = -Infinity;
    });
  }

  setLiveAudio(la: LiveAudio | null) {
    this.liveAudio = la;
  }

  /** Playback state feed (drives the sleep cycle + audio reaction gating). */
  setPlaying(playing: boolean) {
    if (playing === this.isPlaying) return;
    this.isPlaying = playing;
    if (playing) {
      this.everPlayed = true;
      if (this.active && this.drowse > 0.45) this.startWakeScript(performance.now());
    } else {
      this.pausedAt = performance.now();
    }
  }

  /** Track changed — curious glance toward the title area. */
  notifyTrackChange() {
    if (!this.active || this.drowse > 0.3 || this.script) return;
    const now = performance.now();
    if (now - this.startedAt < 3000) return; // don't fight the wake flourish
    this.script = {
      startedAt: now,
      durationMs: 1500,
      steps: [
        { at: 90, x: -6.5, y: -3.6 },
        { at: 450, x: -1.5, y: -4.1 },
        { at: 800, x: 4.5, y: -3.6 },
        { at: 1180, x: 0, y: 0.5 },
      ],
    };
  }

  /** Nose poke while alive: blink, glance at the offender, brief squint. */
  boop() {
    if (!this.active) return;
    const now = performance.now();
    if (this.drowse > 0.4) {
      // Poking a sleeping alien stirs him.
      this.stirUntil = now + 2600;
      return;
    }
    this.startBlink(now, 0, true);
    this.squintUntil = now + 900;
    this.headJerkVel -= 1.6;
    const target = this.mouseTargetsFromPoint(this.mouseX, this.mouseY);
    this.script = {
      startedAt: now,
      durationMs: 900,
      steps: [{ at: 120, x: target.left.x, y: target.left.y }],
    };
  }

  isActive(): boolean {
    return this.active;
  }

  getDebugApi(): FaceAliveDebugApi {
    return {
      getEyeState: () => this.getEyeState(),
      activate: () => this.activate(),
      deactivate: () => this.deactivate(),
      forceBlink: (delayMs) => this.forceBlink(delayMs),
      setDebugOverlay: (visible) => this.setDebugOverlay(visible),
      pumpCones: (bass, mid, high, beat) => {
        if (!this.speakers?.isReady()) return;
        this.coneBass = bass;
        this.coneMid = mid;
        this.coneHigh = high;
        this.speakers.update(16, { bass, mid, high }, beat, beat);
        this.coneTestHoldUntil = performance.now() + 500;
      },
    };
  }

  getEyeState(): FaceAliveEyeState {
    return {
      leftOpenness: this.lastState.leftOpenness,
      rightOpenness: this.lastState.rightOpenness,
      leftPupil: { ...this.lastState.leftPupil },
      rightPupil: { ...this.lastState.rightPupil },
      mode: this.lastState.mode,
    };
  }

  activate() {
    if (this.active) return;
    const now = performance.now();
    this.active = true;
    this.startedAt = now;
    this.lastTickAt = now;
    this.flourishMsLeft = ACTIVATION_FLOURISH_MS;
    this.bassPeak = 0.18;
    this.midPeak = 0.18;
    this.highPeak = 0.18;
    this.drowse = 0;
    this.widen = 0;
    this.pupilScale = WAKE_CONSTRICT_SCALE;
    this.resetEyeMotion(now);
    this.cacheEyeRects(now, true);
    this.startWakeScript(now);
    this.startCursorTracking();
    document.body.classList.add("face-alive");
    if (this.rafHandle === null) {
      this.rafHandle = requestAnimationFrame(this.tick);
    }
  }

  /** Ask main to stream the OS cursor so the eyes can track it off-window. */
  private startCursorTracking() {
    const hs = (window as Window).headspace;
    if (!hs?.setAliveCursorTracking || !hs.onAliveCursor) return;
    this.globalTracking = true;
    this.cursorUnsub = hs.onAliveCursor((pos) => this.handleGlobalCursor(pos.x, pos.y));
    hs.setAliveCursorTracking(true);
  }

  private stopCursorTracking() {
    this.globalTracking = false;
    this.cursorUnsub?.();
    this.cursorUnsub = null;
    (window as Window).headspace?.setAliveCursorTracking?.(false);
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.stopCursorTracking();
    document.body.classList.remove("face-alive", "face-alive-debug");
    this.debugOverlayVisible = false;
    this.script = null;
    this.drowse = 0;
    if (this.headEl) this.headEl.style.transform = "";
    this.setEarRecoil(0, 0);
    this.headLightEl?.style.setProperty("--head-light", "0");
    this.rig?.drawClosed();
    this.speakers?.reset();
    this.clearDebugOverlay();
    this.lastState = { ...INITIAL_STATE };
  }

  toggle() {
    if (this.active) this.deactivate();
    else this.activate();
  }

  forceBlink(delayMs = 0) {
    if (delayMs > 0) {
      window.setTimeout(() => {
        if (this.active) this.startBlink(performance.now(), 0, true);
      }, delayMs);
      return;
    }
    this.startBlink(performance.now(), 0, true);
  }

  setDebugOverlay(visible: boolean) {
    this.debugOverlayVisible = visible && this.active;
    document.body.classList.toggle("face-alive-debug", this.debugOverlayVisible);
    if (!this.debugOverlayVisible) this.clearDebugOverlay();
  }

  toggleDebugOverlay() {
    this.setDebugOverlay(!this.debugOverlayVisible);
  }

  /** Wake-up flourish: orienting saccades + pupil constrict-then-settle. */
  private startWakeScript(now: number) {
    this.pupilScale = WAKE_CONSTRICT_SCALE;
    const side = Math.random() < 0.5 ? 1 : -1;
    this.script = {
      startedAt: now,
      durationMs: 1900,
      steps: [
        { at: 700, x: -7 * side, y: -1.8 },
        { at: 1150, x: 6.2 * side, y: -1.2 },
        { at: 1620, x: 0, y: 0.4 },
      ],
    };
    // A little double-blink as he finishes orienting.
    window.setTimeout(() => {
      if (this.active && !this.blink) this.startBlink(performance.now(), 1, false);
    }, 2050);
  }

  private tick = () => {
    if (!this.active) return;
    const now = performance.now();
    const dtMs = Math.max(8, Math.min(40, now - this.lastTickAt || 16));
    this.lastTickAt = now;
    const elapsedSec = (now - this.startedAt) / 1000;

    // ---- Audio analysis ----
    let bassEnergyRaw = 0;
    let midEnergyRaw = 0;
    let highEnergyRaw = 0;
    let beat = false;
    let onset = false;
    let drop = false;
    if (this.liveAudio) {
      const fft = this.liveAudio.sample();
      if (fft) {
        bassEnergyRaw = bandEnergy(fft, 0.015, 0.1, 1.45);
        midEnergyRaw = bandEnergy(fft, 0.1, 0.38, 1.25);
        highEnergyRaw = bandEnergy(fft, 0.38, 0.78, 1.35);
      }
      if (this.isPlaying) {
        beat = this.liveAudio.checkBeat();
        onset = this.liveAudio.checkOnset();
        drop = this.liveAudio.checkDrop();
      }
    }
    this.bassPeak = Math.max(bassEnergyRaw, this.bassPeak * BAND_PEAK_DECAY);
    this.midPeak = Math.max(midEnergyRaw, this.midPeak * BAND_PEAK_DECAY);
    this.highPeak = Math.max(highEnergyRaw, this.highPeak * BAND_PEAK_DECAY);

    const bassNorm = normalizeEnergy(bassEnergyRaw, this.bassPeak);
    const midNorm = normalizeEnergy(midEnergyRaw, this.midPeak);
    const highNorm = normalizeEnergy(highEnergyRaw, this.highPeak);
    this.bassEnv = smooth(this.bassEnv, bassNorm, 0.38, 0.13);
    this.midEnv = smooth(this.midEnv, midNorm, 0.32, 0.12);
    this.highEnv = smooth(this.highEnv, highNorm, 0.42, 0.16);
    // Speakers want punch: near-instant attack, slow release.
    this.coneBass = smooth(this.coneBass, bassNorm, 0.65, 0.09);
    this.coneMid = smooth(this.coneMid, midNorm, 0.6, 0.09);
    this.coneHigh = smooth(this.coneHigh, highNorm, 0.62, 0.1);
    const intensity = Math.min(1, this.bassEnv * 0.35 + this.midEnv * 0.45 + this.highEnv * 0.2);

    // ---- Behaviors ----
    if (this.flourishMsLeft > 0) {
      this.flourishMsLeft = Math.max(0, this.flourishMsLeft - dtMs);
    }
    this.updateDrowse(now, dtMs);

    if (drop) {
      this.widen = 0.34;
      this.pupilBump = -(1 - DROP_CONSTRICT_SCALE);
      this.headJerkVel -= 2.4;
    } else if (beat) {
      this.pupilBump = Math.max(this.pupilBump, BEAT_PUPIL_BUMP * (0.5 + this.bassEnv));
    }
    this.widen *= Math.exp(-dtMs / 450);
    this.pupilBump *= Math.exp(-dtMs / 260);

    // Pupil: wake constriction settles toward a music-modulated baseline.
    const wakeT = Math.min(1, (now - this.startedAt) / WAKE_PUPIL_SETTLE_MS);
    const baseScale = lerp(WAKE_CONSTRICT_SCALE, 1 + intensity * 0.14, easeOutCubic(wakeT));
    this.pupilScale += (baseScale + this.pupilBump - this.pupilScale) * (1 - Math.exp(-dtMs / 130));

    // ---- Head motion ----
    const bodyBreath = (Math.sin(elapsedSec * Math.PI * 2 * 0.82) + 1) * 0.5;
    // Head-jerk spring (drop reaction / boop recoil).
    const jerkAccel = -180 * this.headJerkPos - 9 * this.headJerkVel;
    this.headJerkVel += jerkAccel * (dtMs / 1000);
    this.headJerkPos += this.headJerkVel * (dtMs / 1000);

    const headSway = Math.sin(elapsedSec * Math.PI * 2 * 0.28) * 0.42;
    const beatLean = (this.bassEnv - this.midEnv * 0.35) * 0.42;
    const drowseNod =
      this.drowse * (1.6 + Math.sin(elapsedSec * Math.PI * 2 * 0.16) * 1.3 + bodyBreath * 0.5);
    const headTx = headSway + beatLean;
    const headTy = bodyBreath * 0.34 + this.bassEnv * 0.2 + this.headJerkPos + drowseNod;
    const headRotDeg =
      Math.sin(elapsedSec * Math.PI * 2 * 0.22 + 0.9) * 0.32 +
      beatLean * 0.42 +
      this.drowse * Math.sin(elapsedSec * Math.PI * 2 * 0.13) * 0.55;

    if (this.headEl) {
      this.headEl.style.transform = `translate(${headTx.toFixed(2)}px, ${headTy.toFixed(
        2,
      )}px) rotate(${headRotDeg.toFixed(3)}deg)`;
    }

    // ---- Eyes ----
    this.cacheEyeRects(now, false);
    const blinkOpenness = this.computeBlinkOpenness(now);
    const eyeMotion = this.computeEyeMotion(now, dtMs, elapsedSec);

    // VOR: counter-apply head displacement so gaze stays world-fixed. Scaled
    // down while drowsing (a sleepy creature's reflexes sag).
    const vorX = -headTx * VOR_GAIN * (1 - this.drowse * 0.7);
    const vorY = -(headTy - drowseNod * 0.5) * VOR_GAIN * (1 - this.drowse * 0.7);
    const leftFinal = clampToSocket({ x: eyeMotion.left.x + vorX, y: eyeMotion.left.y + vorY });
    const rightFinal = clampToSocket({ x: eyeMotion.right.x + vorX, y: eyeMotion.right.y + vorY });

    // Rendered openness: blink gated by drowse and squint.
    const drowseCap = 1 - this.effectiveDrowse(now) * 0.88;
    const squint = now < this.squintUntil ? 0.82 : 1;
    const renderOpenness = Math.min(blinkOpenness, drowseCap) * squint;
    const eyeGlow = Math.min(1.45, 0.95 + intensity * 0.35);

    if (this.rig?.isReady() && this.assetsLoaded) {
      const mk = (p: FaceAlivePupilState): EyeDrawState => ({
        pupilX: p.x,
        pupilY: p.y,
        openness: renderOpenness,
        widen: this.widen,
        pupilScale: this.pupilScale,
        glow: eyeGlow,
      });
      this.rig.draw(mk(leftFinal), mk(rightFinal));
    }

    // ---- Ears + speakers ----
    // pumpCones (test-only) can hold the cones at a forced excursion briefly
    // so screenshots aren't damped back to rest by this loop's silent input.
    const earPulse = this.coneBass * 0.8 + this.coneMid * 0.25;
    this.setEarRecoil(earPulse, bodyBreath);
    if (this.speakers?.isReady() && now >= this.coneTestHoldUntil) {
      const levels: BandLevels = { bass: this.coneBass, mid: this.coneMid, high: this.coneHigh };
      this.speakers.update(dtMs, levels, beat, onset);
    }

    // ---- Head light ----
    if (this.headLightEl) {
      const headLight = Math.min(
        1,
        (0.35 + bodyBreath * 0.18 + this.bassEnv * 0.28 + this.midEnv * 0.34) *
          (1 - this.drowse * 0.6),
      );
      this.headLightEl.style.setProperty("--head-light", headLight.toFixed(3));
    }

    // Report the intended gaze (pre-VOR). VOR is a small render-time counter-
    // offset against head sway; the motion-logic invariant (pupils inside the
    // socket ellipse) is about where the brain aims, which is eyeMotion.
    const mode = this.blink ? "blinking" : eyeMotion.mode;
    this.lastState = {
      leftOpenness: blinkOpenness,
      rightOpenness: blinkOpenness,
      leftPupil: { ...eyeMotion.left },
      rightPupil: { ...eyeMotion.right },
      mode,
    };
    if (this.debugOverlayVisible) this.drawDebugOverlay(eyeMotion.left, eyeMotion.right);

    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private updateDrowse(now: number, dtMs: number) {
    if (this.isPlaying || !this.everPlayed) {
      this.drowse = Math.max(0, this.drowse - dtMs / DROWSE_WAKE_MS);
      return;
    }
    if (now - this.pausedAt > DROWSE_AFTER_PAUSE_MS) {
      this.drowse = Math.min(1, this.drowse + dtMs / DROWSE_RAMP_MS);
    }
  }

  private effectiveDrowse(now: number): number {
    // A stirred sleeper half-opens his eyes for a moment.
    return now < this.stirUntil ? this.drowse * 0.35 : this.drowse;
  }

  private cacheEyeRects(now: number, force: boolean) {
    if (!force && now - this.eyeRectsCachedAt < 1500) return;
    this.eyeRectsCachedAt = now;
    this.leftEyeRect = this.leftEyeEl?.getBoundingClientRect() ?? null;
    this.rightEyeRect = this.rightEyeEl?.getBoundingClientRect() ?? null;
  }

  private resetEyeMotion(now: number) {
    this.nextBlinkAt = now + EYE_WAKE_OPEN_MS + randomRange(...BLINK_INTERVAL_RANGE_MS);
    this.blink = null;
    this.openness = BLINK_MIN_OPENNESS;
    this.leftPupil = { x: 0, y: 0 };
    this.rightPupil = { x: 0, y: 0 };
    this.idleFixation = { x: 0, y: 0 };
    this.idleDrift = null;
    this.nextIdleTargetAt = now + 1200;
    this.idleThinkingUntil = 0;
    this.microJitter = { x: 0, y: 0 };
    this.microJitterTarget = { x: 0, y: 0 };
    this.nextMicroJitterAt = now + randomRange(...MICRO_JITTER_INTERVAL_RANGE_MS);
    this.saccade = null;
    this.saccadeRequested = false;
    this.lastMouseMoveAt = now - IDLE_AFTER_MOUSE_MS - 1;
    this.windowLeftAt = -Infinity;
    this.headJerkPos = 0;
    this.headJerkVel = 0;
    this.pupilBump = 0;
    this.squintUntil = 0;
    this.lastState = { ...INITIAL_STATE };
  }

  private computeBlinkOpenness(now: number): number {
    const wakeT = Math.min(1, (now - this.startedAt) / EYE_WAKE_OPEN_MS);
    const wakeOpen = BLINK_MIN_OPENNESS + easeOutCubic(wakeT) * (1 - BLINK_MIN_OPENNESS);
    if (wakeT < 1) {
      this.openness = wakeOpen;
      return this.openness;
    }

    const blinkDuration = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;
    if (!this.blink && now >= this.nextBlinkAt) {
      this.startBlink(now, Math.random() < DOUBLE_BLINK_CHANCE ? 1 : 0, false);
    }

    if (this.blink) {
      const age = now - this.blink.startAt;
      if (age < BLINK_CLOSE_MS) {
        this.openness = lerp(1, BLINK_MIN_OPENNESS, clamp01(age / BLINK_CLOSE_MS));
        return this.openness;
      }
      if (age < BLINK_CLOSE_MS + BLINK_HOLD_MS) {
        this.openness = BLINK_MIN_OPENNESS;
        return this.openness;
      }
      if (age < blinkDuration) {
        // Linear opening. Real lids open at a roughly constant (slightly
        // decelerating) rate — never accelerating. A linear ramp is also the
        // smoothest possible interpolation: constant per-frame delta, no steep
        // tail to amplify scheduler jitter into a visible step.
        const openT = (age - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
        this.openness = lerp(BLINK_MIN_OPENNESS, 1, clamp01(openT));
        return this.openness;
      }

      if (this.blink.queuedAfter > 0 && age < blinkDuration + BLINK_DOUBLE_GAP_MS) {
        this.openness = 1;
        return this.openness;
      }
      if (this.blink.queuedAfter > 0) {
        this.startBlink(now, this.blink.queuedAfter - 1, false);
        this.openness = 1;
        return this.openness;
      }

      const wasForced = this.blink.forced;
      this.blink = null;
      this.openness = 1;
      // Drowsy blinks come more often (heavy lids).
      const interval = randomRange(...BLINK_INTERVAL_RANGE_MS) * (1 - this.drowse * 0.45);
      this.nextBlinkAt = now + (wasForced ? 950 : interval);
    }

    this.openness = 1;
    return this.openness;
  }

  private startBlink(now: number, queuedAfter: number, forced: boolean) {
    this.blink = { startAt: now, queuedAfter, forced };
  }

  private computeEyeMotion(
    now: number,
    dtMs: number,
    elapsedSec: number,
  ): EyeTargets & { mode: Exclude<FaceAliveMode, "blinking"> } {
    this.updateMicroJitter(now);

    // Scripted gaze (wake flourish, track glance, boop) takes priority.
    if (this.script) {
      const age = now - this.script.startedAt;
      if (age >= this.script.durationMs) {
        this.script = null;
      } else {
        let target: FaceAlivePupilState = { x: this.leftPupil.x, y: this.leftPupil.y };
        for (const step of this.script.steps) {
          if (age >= step.at) target = { x: step.x, y: step.y };
        }
        const pursuit = 1 - Math.exp(-dtMs / 48);
        this.leftPupil = lerpPoint(this.leftPupil, target, pursuit);
        this.rightPupil = lerpPoint(this.rightPupil, target, pursuit);
        return {
          left: clampToSocket(this.leftPupil),
          right: clampToSocket(this.rightPupil),
          mode: "idle",
        };
      }
    }

    // Heavy drowse: gaze sinks and stops caring about the mouse.
    if (this.effectiveDrowse(now) > 0.55) {
      const sink = { x: 0, y: 2.5 + this.drowse * 3 };
      const drift = 1 - Math.exp(-dtMs / 320);
      this.leftPupil = lerpPoint(this.leftPupil, sink, drift);
      this.rightPupil = lerpPoint(this.rightPupil, sink, drift);
      return {
        left: clampToSocket(this.leftPupil),
        right: clampToSocket(this.rightPupil),
        mode: "idle",
      };
    }

    const mouseRecentlyMoved = this.mouseInWindow && now - this.lastMouseMoveAt <= IDLE_AFTER_MOUSE_MS;
    const returningToCenter =
      !this.mouseInWindow && now - this.windowLeftAt >= 0 && now - this.windowLeftAt < WINDOW_RETURN_MS;

    if (mouseRecentlyMoved) {
      const mouseTargets = this.mouseTargetsFromPoint(this.mouseX, this.mouseY);
      if (this.saccadeRequested && !this.saccade) {
        this.startSaccade(now, mouseTargets);
      }
      this.saccadeRequested = false;

      if (this.saccade) {
        const saccadeTargets = this.advanceSaccade(now, mouseTargets);
        if (saccadeTargets) {
          this.leftPupil = saccadeTargets.left;
          this.rightPupil = saccadeTargets.right;
          return { ...saccadeTargets, mode: "saccade" };
        }
      }

      const pursuit = 1 - Math.exp(-dtMs / PURSUIT_TIME_CONSTANT_MS);
      this.leftPupil = lerpPoint(this.leftPupil, mouseTargets.left, pursuit);
      this.rightPupil = lerpPoint(this.rightPupil, mouseTargets.right, pursuit);
      return {
        left: clampToSocket(this.leftPupil),
        right: clampToSocket(this.rightPupil),
        mode: "tracking",
      };
    }

    this.saccade = null;
    const idleTargets = returningToCenter
      ? { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }
      : this.computeIdleTargets(now, elapsedSec);
    const drift = returningToCenter ? 1 - Math.exp(-dtMs / 115) : 1 - Math.exp(-dtMs / 95);
    this.leftPupil = lerpPoint(this.leftPupil, idleTargets.left, drift);
    this.rightPupil = lerpPoint(this.rightPupil, idleTargets.right, drift);

    return {
      left: clampToSocket(this.leftPupil),
      right: clampToSocket(this.rightPupil),
      mode: "idle",
    };
  }

  /**
   * Map a screen point to per-eye pupil offsets. Both eyes aim from a shared
   * gaze center (no wall-eye), then converge toward the nose by proximity —
   * a cursor right between the eyes makes him slightly cross-eyed.
   */
  private mouseTargetsFromPoint(x: number, y: number): EyeTargets {
    const leftRect = this.leftEyeRect;
    const rightRect = this.rightEyeRect;
    if (!leftRect || !rightRect) {
      return { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    }
    const sharedCenterX =
      (leftRect.left + leftRect.width / 2 + rightRect.left + rightRect.width / 2) / 2;
    const centerY = leftRect.top + leftRect.height / 2 + EYE_GAZE_CENTER_Y_OFFSET;
    const dx = x - sharedCenterX;
    const dy = y - centerY;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const pull = clamp01(dist / 170);
    const radiusY = dy < 0 ? EYE_MAX_UP_Y : EYE_MAX_DOWN_Y;
    const base = {
      x: (dx / dist) * SOCKET_RADIUS_X * pull,
      y: (dy / dist) * radiusY * pull,
    };
    const vergence = clamp01(1 - dist / VERGENCE_NEAR_PX) * VERGENCE_MAX_PX;
    return {
      left: clampToSocket({ x: base.x + vergence, y: base.y }),
      right: clampToSocket({ x: base.x - vergence, y: base.y }),
    };
  }

  private startSaccade(now: number, target: EyeTargets) {
    const from = {
      left: { ...this.leftPupil },
      right: { ...this.rightPupil },
    };
    const overshoot = {
      left: overshootPoint(from.left, target.left, 0.16),
      right: overshootPoint(from.right, target.right, 0.16),
    };
    this.saccade = {
      startAt: now,
      jumpMs: randomRange(...SACCADE_JUMP_RANGE_MS),
      settleMs: SACCADE_SETTLE_MS,
      from,
      overshoot,
      target,
    };
  }

  private advanceSaccade(now: number, liveTarget: EyeTargets): EyeTargets | null {
    if (!this.saccade) return null;
    const age = now - this.saccade.startAt;
    if (age < this.saccade.jumpMs) {
      const t = easeOutCubic(age / this.saccade.jumpMs);
      return {
        left: clampToSocket(lerpPoint(this.saccade.from.left, this.saccade.overshoot.left, t)),
        right: clampToSocket(lerpPoint(this.saccade.from.right, this.saccade.overshoot.right, t)),
      };
    }
    const settleAge = age - this.saccade.jumpMs;
    if (settleAge < this.saccade.settleMs) {
      const settleTarget = {
        left: lerpPoint(this.saccade.target.left, liveTarget.left, 0.35),
        right: lerpPoint(this.saccade.target.right, liveTarget.right, 0.35),
      };
      const t = easeOutCubic(settleAge / this.saccade.settleMs);
      return {
        left: clampToSocket(lerpPoint(this.saccade.overshoot.left, settleTarget.left, t)),
        right: clampToSocket(lerpPoint(this.saccade.overshoot.right, settleTarget.right, t)),
      };
    }
    this.saccade = null;
    return null;
  }

  private computeIdleTargets(now: number, elapsedSec: number): EyeTargets {
    if (now >= this.nextIdleTargetAt && now >= this.idleThinkingUntil) {
      this.startIdleDrift(now);
    }

    if (this.idleDrift) {
      const t = clamp01((now - this.idleDrift.startAt) / this.idleDrift.durationMs);
      this.idleFixation = lerpPoint(this.idleDrift.from, this.idleDrift.target, easeInOutCubic(t));
      if (t >= 1) this.idleDrift = null;
    }

    const breathJitter = {
      x: Math.sin(elapsedSec * Math.PI * 2 * 0.73) * 0.42,
      y: Math.sin(elapsedSec * Math.PI * 2 * 0.61 + 1.4) * 0.26,
    };
    const held = clampToSocket({
      x: this.idleFixation.x + this.microJitter.x + breathJitter.x,
      y: this.idleFixation.y + this.microJitter.y + breathJitter.y,
    });

    return {
      left: held,
      right: held,
    };
  }

  private startIdleDrift(now: number) {
    const thinking = Math.random() < THINKING_PATTERN_CHANCE;
    const durationMs = randomRange(...IDLE_DRIFT_DURATION_RANGE_MS);
    const side = Math.random() < 0.5 ? -1 : 1;
    const target = thinking
      ? { x: side * randomRange(5.8, 8.3), y: randomRange(-4.2, -2.6) }
      : {
          x: randomRange(-IDLE_FIXATION_RANGE_X, IDLE_FIXATION_RANGE_X),
          y: randomRange(-IDLE_FIXATION_RANGE_Y, IDLE_FIXATION_RANGE_Y),
        };

    this.idleDrift = {
      startAt: now,
      durationMs,
      from: { ...this.idleFixation },
      target: clampToSocket(target),
    };

    if (Math.random() < IDLE_DESTINATION_BLINK_CHANCE) {
      window.setTimeout(() => {
        if (this.active && !this.blink) this.startBlink(performance.now(), 0, false);
      }, durationMs);
    }

    if (thinking) {
      this.idleThinkingUntil = now + durationMs + 800;
      this.nextIdleTargetAt = this.idleThinkingUntil + randomRange(1300, 2600);
    } else {
      this.nextIdleTargetAt = now + randomRange(...IDLE_TARGET_INTERVAL_RANGE_MS);
    }
  }

  private updateMicroJitter(now: number) {
    if (now >= this.nextMicroJitterAt) {
      this.microJitterTarget = {
        x: randomRange(-MICRO_JITTER_RANGE_PX, MICRO_JITTER_RANGE_PX),
        y: randomRange(-MICRO_JITTER_RANGE_PX, MICRO_JITTER_RANGE_PX) * 0.72,
      };
      this.nextMicroJitterAt = now + randomRange(...MICRO_JITTER_INTERVAL_RANGE_MS);
    }
    this.microJitter = lerpPoint(this.microJitter, this.microJitterTarget, 0.32);
  }

  private handlePointerMove = (e: PointerEvent) => {
    // Over the window, DOM clientX/clientY and the global cursor feed agree
    // exactly (same window-relative CSS pixels), so this is redundant while
    // global tracking is live — but it keeps the eyes working if the global
    // feed is unavailable (e.g. the face test, which drives a synthetic mouse).
    this.feedCursor(e.clientX, e.clientY);
  };

  /** Window-relative cursor from the main-process global poll (any screen pos). */
  private handleGlobalCursor = (x: number, y: number) => {
    this.feedCursor(x, y);
  };

  private feedCursor(clientX: number, clientY: number) {
    const now = performance.now();
    const dt = now - this.lastPointerSampleAt;
    const dx = clientX - this.lastMouseX;
    const dy = clientY - this.lastMouseY;
    const moved = Math.hypot(dx, dy);

    this.mouseInWindow = true;
    this.mouseX = clientX;
    this.mouseY = clientY;
    this.lastMouseX = clientX;
    this.lastMouseY = clientY;
    this.lastPointerSampleAt = now;

    if (moved > 0.5) {
      this.lastMouseMoveAt = now;
      if (this.drowse > 0.2) this.stirUntil = now + 1800;
    }
    if (this.active && dt > 0 && dt < SACCADE_WINDOW_MS && moved > SACCADE_DISTANCE_PX) {
      this.saccadeRequested = true;
    }
  }

  private handlePointerLeave = () => {
    // With global cursor tracking we always know where the cursor is, even off
    // the window, so a window-leave is not a reason to stop tracking.
    if (this.globalTracking) return;
    this.mouseInWindow = false;
    this.windowLeftAt = performance.now();
    this.saccadeRequested = false;
  };

  /**
   * Ear recoil: containers carry the CSS vars; the ear images and speaker
   * canvases share the exact same transform so they move as one rigid body.
   */
  private setEarRecoil(earPulse: number, bodyBreath = 0) {
    const make = (direction: number) => {
      const abs = Math.abs(direction);
      const x = direction * 1.8;
      const y = -abs * 0.55 + bodyBreath * 0.18;
      const tilt = direction * 0.32;
      return { x, y, tilt };
    };
    const right = make(earPulse); // #pl-ear
    const left = make(-earPulse); // #eq-ear
    const apply = (
      container: HTMLElement | null,
      img: HTMLElement | null,
      v: { x: number; y: number; tilt: number },
      mirrored: boolean,
    ) => {
      if (!container) return "";
      container.style.setProperty("--ear-recoil-x", `${v.x.toFixed(2)}px`);
      container.style.setProperty("--ear-recoil-y", `${v.y.toFixed(2)}px`);
      container.style.setProperty("--ear-tilt", `${v.tilt.toFixed(3)}deg`);
      const t = `translate(${v.x.toFixed(2)}px, ${v.y.toFixed(2)}px) rotate(${v.tilt.toFixed(
        3,
      )}deg)${mirrored ? " scaleX(-1)" : ""}`;
      if (img) img.style.transform = t;
      return t;
    };
    const rightT = apply(this.rightEarContainerEl, this.rightEarEl, right, false);
    const leftT = apply(this.leftEarContainerEl, this.leftEarEl, left, true);
    this.speakers?.setRecoil([rightT, leftT]);
  }

  private drawDebugOverlay(leftPupil: FaceAlivePupilState, rightPupil: FaceAlivePupilState) {
    const canvas = this.debugCanvasEl;
    const leftRect = this.leftEyeRect;
    const rightRect = this.rightEyeRect;
    const groupRect = this.headEl?.getBoundingClientRect();
    if (!canvas || !leftRect || !rightRect || !groupRect) return;

    canvas.width = 234;
    canvas.height = 394;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(80, 220, 255, 0.9)";
    ctx.fillStyle = "rgba(80, 220, 255, 0.95)";
    this.drawEyeDebug(ctx, leftRect, groupRect, leftPupil);
    this.drawEyeDebug(ctx, rightRect, groupRect, rightPupil);
  }

  private drawEyeDebug(
    ctx: CanvasRenderingContext2D,
    rect: DOMRect,
    groupRect: DOMRect,
    pupil: FaceAlivePupilState,
  ) {
    const cx = rect.left - groupRect.left + rect.width / 2;
    const cy = rect.top - groupRect.top + rect.height / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, SOCKET_RADIUS_X, 5.8, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 240, 90, 0.95)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + pupil.x, cy + pupil.y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(80, 220, 255, 0.9)";
  }

  private clearDebugOverlay() {
    const ctx = this.debugCanvasEl?.getContext("2d");
    if (!ctx || !this.debugCanvasEl) return;
    ctx.clearRect(0, 0, this.debugCanvasEl.width, this.debugCanvasEl.height);
  }
}

function easeOutCubic(t: number): number {
  const clamped = clamp01(t);
  return 1 - Math.pow(1 - clamped, 3);
}

function easeInOutCubic(t: number): number {
  const clamped = clamp01(t);
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function lerpPoint(a: FaceAlivePupilState, b: FaceAlivePupilState, t: number): FaceAlivePupilState {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  };
}

function overshootPoint(from: FaceAlivePupilState, target: FaceAlivePupilState, amount: number): FaceAlivePupilState {
  return clampToSocket({
    x: target.x + (target.x - from.x) * amount,
    y: target.y + (target.y - from.y) * amount,
  });
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clampToSocket(point: FaceAlivePupilState): FaceAlivePupilState {
  const radiusY = point.y < 0 ? EYE_MAX_UP_Y : EYE_MAX_DOWN_Y;
  const normalized = Math.hypot(point.x / SOCKET_RADIUS_X, point.y / radiusY);
  if (normalized <= 1) return { x: point.x, y: point.y };
  return {
    x: point.x / normalized,
    y: point.y / normalized,
  };
}

function bandEnergy(fft: Uint8Array, startFrac: number, endFrac: number, gain: number): number {
  const lo = Math.max(0, Math.floor(fft.length * startFrac));
  const hi = Math.min(fft.length, Math.max(lo + 1, Math.floor(fft.length * endFrac)));
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += fft[i];
  return Math.min(1, (sum / (hi - lo) / 255) * gain);
}

function normalizeEnergy(value: number, peak: number): number {
  return clamp01(value / Math.max(0.12, peak * 0.78));
}

function smooth(previous: number, next: number, attack: number, release: number): number {
  const rate = next > previous ? attack : release;
  return previous + (next - previous) * rate;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
