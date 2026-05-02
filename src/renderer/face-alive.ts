/**
 * FaceAlive — Easter-egg "alive head" mode.
 *
 * When activated (5 clicks on the nose hitbox within 2 seconds, wired in
 * renderer.ts), the alien head subtly comes to life:
 *  - Ears scale-pulse with audio intensity (speaker throb)
 *  - Head sways with a low-frequency sine wave (gentle "breathing")
 *  - Hard beats produce a quick scale-pulse + slight head tilt
 *  - Onsets nudge the head a few pixels in random directions ("looking around")
 *
 * Self-contained: removing this feature is `delete face-alive.ts` + remove
 * the import + nose hitbox from index.html + the wiring block in renderer.ts.
 * Nothing else in the app references it.
 *
 * Intentionally subtle by default — the goal is "the head is breathing" not
 * "the head is having a seizure". Tunables are constants near the top.
 */

import type { LiveAudio } from "./live-audio";

// Tuning. Alive mode should read immediately, with audio adding punch.
const EAR_BASE_PULSE = 0.04; // retained for compatibility with old call shape
const EAR_BEAT_BURST = 0.08; // retained for compatibility with old call shape
const EAR_DECAY_PER_FRAME = 0.85; // how fast the beat-burst falls off
const HEAD_SWAY_HZ = 0.18; // gentle sway frequency (cycles/sec)
const HEAD_SWAY_PX = 1.05; // sway amplitude in pixels
const HEAD_BEAT_TILT_DEG = 0.75; // rotation kick on beat
const HEAD_BEAT_BOB_PX = 1.0; // vertical kick on beat
const HEAD_ONSET_NUDGE_PX = 0.55; // tiny "look around" jitter on onsets
const HEAD_DECAY_PER_FRAME = 0.86; // beat/onset return-to-rest rate
const ACTIVATION_FLOURISH_MS = 1100; // duration of the wake-up animation
const EYE_WAKE_OPEN_MS = 620;
const EYE_BLINK_MIN_GAP_MS = 1900;
const EYE_BLINK_RANDOM_GAP_MS = 3600;
const CONE_DECAY_PER_FRAME = 0.82;
const BAND_PEAK_DECAY = 0.992;

export class FaceAlive {
  private active = false;
  private liveAudio: LiveAudio | null = null;
  private rafHandle: number | null = null;
  private headEl: HTMLElement | null;
  private leftEarEl: HTMLElement | null;
  private rightEarEl: HTMLElement | null;
  private leftEarContainerEl: HTMLElement | null;
  private rightEarContainerEl: HTMLElement | null;
  private leftEyeEl: HTMLElement | null;
  private rightEyeEl: HTMLElement | null;
  private headLightEl: HTMLElement | null;
  private coneBassEls: HTMLElement[] = [];
  private coneMidEls: HTMLElement[] = [];
  private coneHighEls: HTMLElement[] = [];

  // Per-frame transient state, all decay back toward zero each frame.
  private earBeatPulse = 0;
  private headBeatTilt = 0;
  private headBeatBob = 0;
  private headLookX = 0;
  private headLookY = 0;
  private coneBeatPulse = 0;
  private bassEnv = 0;
  private midEnv = 0;
  private highEnv = 0;
  private bassPeak = 0.18;
  private midPeak = 0.18;
  private highPeak = 0.18;
  private gazeX = 0;
  private gazeY = 0;
  private gazeTargetX = 0;
  private gazeTargetY = 0;
  private nextGazeAt = 0;
  // Wake-up flourish countdown (ms remaining).
  private flourishMsLeft = 0;
  private startedAt = 0;
  private nextBlinkAt = 0;
  private blinkStartedAt = 0;
  private blinkDurationMs = 150;

  constructor() {
    // Transform the WRAPPER (head + eyes) so they sway/tilt together.
    // Without this the head moves but the eyes stay pinned, sliding off the
    // face as the sway animation plays.
    this.headEl = document.getElementById("head-group");
    this.leftEarEl = document.querySelector("#eq-ear .ear-img");
    this.rightEarEl = document.querySelector("#pl-ear .ear-img");
    this.leftEarContainerEl = document.getElementById("eq-ear");
    this.rightEarContainerEl = document.getElementById("pl-ear");
    this.leftEyeEl = document.getElementById("alive-eye-left");
    this.rightEyeEl = document.getElementById("alive-eye-right");
    this.headLightEl = document.getElementById("alive-head-light");
    this.coneBassEls = Array.from(document.querySelectorAll<HTMLElement>('.speaker-cone[data-band="bass"]'));
    this.coneMidEls = Array.from(document.querySelectorAll<HTMLElement>('.speaker-cone[data-band="mid"]'));
    this.coneHighEls = Array.from(document.querySelectorAll<HTMLElement>('.speaker-cone[data-band="high"]'));
  }

  setLiveAudio(la: LiveAudio | null) {
    this.liveAudio = la;
  }

  isActive(): boolean {
    return this.active;
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.startedAt = performance.now();
    this.flourishMsLeft = ACTIVATION_FLOURISH_MS;
    this.nextBlinkAt = this.startedAt + 950;
    this.blinkStartedAt = 0;
    this.nextGazeAt = this.startedAt + 700;
    this.bassPeak = 0.18;
    this.midPeak = 0.18;
    this.highPeak = 0.18;
    document.body.classList.add("face-alive");
    if (this.rafHandle === null) {
      this.rafHandle = requestAnimationFrame(this.tick);
    }
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    document.body.classList.remove("face-alive");
    // Reset all transforms so the head returns to its default pose.
    this.applyTransforms(0, 0, 0, 1, 1, 1, 0.08, 0, 0, 0, 0, 0, 0, 0);
  }

  toggle() {
    if (this.active) this.deactivate();
    else this.activate();
  }

  private tick = () => {
    if (!this.active) return;
    const now = performance.now();
    const elapsedSec = (now - this.startedAt) / 1000;

    // ---- Sample audio if available (gated by Spotify isPlaying upstream
    //      via the same logic the visualizer uses — but FaceAlive doesn't
    //      know about that; it just trusts whatever sample() returns). ----
    let intensity = 0;
    let bassEnergyRaw = 0;
    let midEnergyRaw = 0;
    let highEnergyRaw = 0;
    let beatHit = false;
    let onset = false;
    if (this.liveAudio) {
      const fft = this.liveAudio.sample();
      if (fft) {
        bassEnergyRaw = bandEnergy(fft, 0.015, 0.1, 1.45);
        midEnergyRaw = bandEnergy(fft, 0.1, 0.38, 1.25);
        highEnergyRaw = bandEnergy(fft, 0.38, 0.78, 1.35);
        beatHit = this.liveAudio.checkBeat();
        onset = this.liveAudio.checkOnset();
      }
    }
    this.bassPeak = Math.max(bassEnergyRaw, this.bassPeak * BAND_PEAK_DECAY);
    this.midPeak = Math.max(midEnergyRaw, this.midPeak * BAND_PEAK_DECAY);
    this.highPeak = Math.max(highEnergyRaw, this.highPeak * BAND_PEAK_DECAY);

    this.bassEnv = smooth(this.bassEnv, normalizeEnergy(bassEnergyRaw, this.bassPeak), 0.38, 0.13);
    this.midEnv = smooth(this.midEnv, normalizeEnergy(midEnergyRaw, this.midPeak), 0.32, 0.12);
    this.highEnv = smooth(this.highEnv, normalizeEnergy(highEnergyRaw, this.highPeak), 0.42, 0.16);
    intensity = Math.min(1, this.bassEnv * 0.35 + this.midEnv * 0.45 + this.highEnv * 0.2);

    // ---- Apply impulses to transient state ----
    if (beatHit) {
      this.earBeatPulse = 1;
      this.coneBeatPulse = 1;
      this.headBeatTilt = (Math.random() < 0.5 ? -1 : 1) * HEAD_BEAT_TILT_DEG;
      this.headBeatBob = HEAD_BEAT_BOB_PX;
    }
    if (onset) {
      // Random tiny look-around nudge.
      this.headLookX += (Math.random() - 0.5) * HEAD_ONSET_NUDGE_PX * 2;
      this.headLookY += (Math.random() - 0.5) * HEAD_ONSET_NUDGE_PX * 2;
    }
    if (now >= this.nextGazeAt) {
      this.gazeTargetX = (Math.random() - 0.5) * 2.2;
      this.gazeTargetY = (Math.random() - 0.5) * 0.8;
      this.nextGazeAt = now + 750 + Math.random() * 1900;
    }
    this.gazeX += (this.gazeTargetX - this.gazeX) * 0.04;
    this.gazeY += (this.gazeTargetY - this.gazeY) * 0.04;

    // ---- Decay transients back toward rest ----
    this.earBeatPulse *= EAR_DECAY_PER_FRAME;
    this.coneBeatPulse *= CONE_DECAY_PER_FRAME;
    this.headBeatTilt *= HEAD_DECAY_PER_FRAME;
    this.headBeatBob *= HEAD_DECAY_PER_FRAME;
    this.headLookX *= HEAD_DECAY_PER_FRAME;
    this.headLookY *= HEAD_DECAY_PER_FRAME;

    // ---- Compute final transform values ----
    const swayPhase = elapsedSec * HEAD_SWAY_HZ * Math.PI * 2;
    const swayX = Math.sin(swayPhase) * HEAD_SWAY_PX;
    const swayY = Math.sin(swayPhase * 0.6) * HEAD_SWAY_PX * 0.6;
    const bodyBreath = (Math.sin(elapsedSec * Math.PI * 2 * 0.82) + 1) * 0.5;
    const coneBreathBass = (Math.sin(elapsedSec * Math.PI * 2 * 1.55) + 1) * 0.5;
    const coneBreathMid = (Math.sin(elapsedSec * Math.PI * 2 * 1.95 + 1.7) + 1) * 0.5;
    const coneBreathHigh = (Math.sin(elapsedSec * Math.PI * 2 * 2.65 + 3.1) + 1) * 0.5;

    const bassEnergy = clamp01(0.18 + coneBreathBass * 0.22 + this.bassEnv * 0.56 + this.coneBeatPulse * 0.36);
    const midEnergy = clamp01(0.14 + coneBreathMid * 0.18 + this.midEnv * 0.52 + this.coneBeatPulse * 0.22);
    const highEnergy = clamp01(0.1 + coneBreathHigh * 0.2 + this.highEnv * 0.54 + this.coneBeatPulse * 0.16);

    let tx = swayX + this.headLookX;
    let ty = swayY + bodyBreath * 0.45 + this.headLookY - this.headBeatBob;
    let rot = this.headBeatTilt;
    const earScale = 1 + intensity * EAR_BASE_PULSE + this.earBeatPulse * EAR_BEAT_BURST;

    // ---- Activation flourish: brief wake-up animation overlay ----
    if (this.flourishMsLeft > 0) {
      this.flourishMsLeft = Math.max(0, this.flourishMsLeft - 16);
      const t = 1 - this.flourishMsLeft / ACTIVATION_FLOURISH_MS; // 0→1
      // Quick "head shake" then settle.
      const wake = Math.sin(t * Math.PI * 2.5) * (1 - t) * 3.2;
      tx += wake;
      rot += wake * 0.6;
    }

    // Eyes glow brighter with intensity, with a slight beat-burst kick.
    // Base brightness 0.85 so they're always clearly visible when alive
    // mode is on, even during quiet passages. Capped at 1.4 so loud passages
    // don't bloom into pure white.
    const eyeGlow = Math.min(1.55, 0.95 + intensity * 0.45 + this.earBeatPulse * 0.24);
    const blinkScale = this.computeBlinkScale(now);
    const lookX = Math.sin(elapsedSec * 0.72 + 0.4) * 0.8 + this.gazeX + this.headLookX * 0.45;
    const lookY = Math.sin(elapsedSec * 0.48 + 1.3) * 0.35 + this.gazeY + this.headLookY * 0.35;
    this.applyTransforms(
      tx,
      ty,
      rot,
      earScale,
      earScale,
      eyeGlow,
      blinkScale,
      lookX,
      lookY,
      bassEnergy,
      midEnergy,
      highEnergy,
      Math.max(coneBreathBass, coneBreathMid, coneBreathHigh),
      bodyBreath,
    );

    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private computeBlinkScale(now: number): number {
    const wakeT = Math.min(1, (now - this.startedAt) / EYE_WAKE_OPEN_MS);
    const wakeScale = 0.08 + easeOutCubic(wakeT) * 0.92;

    let blinkScale = 1;
    if (this.blinkStartedAt === 0 && now >= this.nextBlinkAt) {
      this.blinkStartedAt = now;
      this.blinkDurationMs = 125 + Math.random() * 75;
    }

    if (this.blinkStartedAt !== 0) {
      const t = (now - this.blinkStartedAt) / this.blinkDurationMs;
      if (t >= 1) {
        this.blinkStartedAt = 0;
        this.nextBlinkAt = now + EYE_BLINK_MIN_GAP_MS + Math.random() * EYE_BLINK_RANDOM_GAP_MS;
      } else if (t < 0.42) {
        blinkScale = 1 - easeOutCubic(t / 0.42) * 0.92;
      } else {
        blinkScale = 0.08 + easeOutCubic((t - 0.42) / 0.58) * 0.92;
      }
    }

    return Math.min(wakeScale, blinkScale);
  }

  private applyTransforms(
    headTx: number,
    headTy: number,
    headRotDeg: number,
    leftEarScale: number,
    rightEarScale: number,
    eyeGlow: number = 1,
    blinkScale: number = 1,
    eyeLookX: number = 0,
    eyeLookY: number = 0,
    bassEnergy: number = 0,
    midEnergy: number = 0,
    highEnergy: number = 0,
    coneBreathe: number = 0,
    bodyBreath: number = 0,
  ) {
    if (this.headEl) {
      this.headEl.style.transform = `translate(${headTx.toFixed(2)}px, ${headTy.toFixed(2)}px) rotate(${headRotDeg.toFixed(3)}deg)`;
    }
    const recoil = Math.min(1, bassEnergy * 0.72 + this.coneBeatPulse * 0.7);
    this.applyEarRecoil(this.leftEarContainerEl, this.leftEarEl, -recoil, bodyBreath, true);
    this.applyEarRecoil(this.rightEarContainerEl, this.rightEarEl, recoil, bodyBreath, false);
    const coneBeat = this.coneBeatPulse.toFixed(3);
    this.applyConeEnergy(this.coneBassEls, bassEnergy, coneBeat, coneBreathe);
    this.applyConeEnergy(this.coneMidEls, midEnergy, coneBeat, 1 - coneBreathe * 0.45);
    this.applyConeEnergy(this.coneHighEls, highEnergy, coneBeat, (coneBreathe + 0.33) % 1);
    if (this.headLightEl) {
      const headLight = Math.min(1, 0.35 + bodyBreath * 0.18 + bassEnergy * 0.28 + midEnergy * 0.34 + this.coneBeatPulse * 0.28);
      this.headLightEl.style.setProperty("--head-light", headLight.toFixed(3));
    }
    // Drive eye brightness, gaze, and lid motion via CSS vars so the artwork
    // stays in CSS while the animation loop supplies the living motion.
    const lidClose = 1 - blinkScale;
    const lidTopY = -9 + lidClose * 13;
    const lidBottomY = 5 - lidClose * 2;
    const eyeBeat = Math.min(1, this.earBeatPulse);
    for (const eyeEl of [this.leftEyeEl, this.rightEyeEl]) {
      if (!eyeEl) continue;
      eyeEl.style.setProperty("--eye-glow", eyeGlow.toFixed(3));
      eyeEl.style.setProperty("--eye-beat", eyeBeat.toFixed(3));
      eyeEl.style.setProperty("--blink-scale", blinkScale.toFixed(3));
      eyeEl.style.setProperty("--lid-close", lidClose.toFixed(3));
      eyeEl.style.setProperty("--lid-top-y", `${lidTopY.toFixed(2)}px`);
      eyeEl.style.setProperty("--lid-bottom-y", `${lidBottomY.toFixed(2)}px`);
      eyeEl.style.setProperty("--eye-look-x", `${eyeLookX.toFixed(2)}px`);
      eyeEl.style.setProperty("--eye-look-y", `${eyeLookY.toFixed(2)}px`);
    }
  }

  private applyConeEnergy(cones: HTMLElement[], energy: number, beat: string, breathe: number) {
    const value = energy.toFixed(3);
    const breatheValue = breathe.toFixed(3);
    for (const cone of cones) {
      cone.style.setProperty("--cone-energy", value);
      cone.style.setProperty("--cone-beat", beat);
      cone.style.setProperty("--cone-breathe", breatheValue);
    }
  }

  private applyEarRecoil(
    earEl: HTMLElement | null,
    earImgEl: HTMLElement | null,
    direction: number,
    bodyBreath: number,
    mirrored: boolean,
  ) {
    if (!earEl) return;
    const abs = Math.abs(direction);
    const x = direction * 1.8;
    const y = -abs * 0.55 + bodyBreath * 0.18;
    const tilt = direction * 0.32;
    earEl.style.setProperty("--ear-recoil-x", `${x.toFixed(2)}px`);
    earEl.style.setProperty("--ear-recoil-y", `${y.toFixed(2)}px`);
    earEl.style.setProperty("--ear-tilt", `${tilt.toFixed(3)}deg`);
    if (earImgEl) {
      const mirror = mirrored ? " scaleX(-1)" : "";
      earImgEl.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${tilt.toFixed(3)}deg)${mirror}`;
    }
  }
}

function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
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
