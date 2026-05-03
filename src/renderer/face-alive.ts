/**
 * FaceAlive - Easter-egg "alive head" mode.
 *
 * When activated (5 clicks on the nose hitbox within 2 seconds, wired in
 * renderer.ts), the alien head subtly comes to life:
 *  - Eyes open, blink, track the mouse, and idle-wander
 *  - Eye glow tracks audio intensity subtly
 *  - Speaker cones and head light breathe with live audio
 *
 * Self-contained: removing this feature is `delete face-alive.ts` + remove
 * the import + nose hitbox from index.html + the wiring block in renderer.ts.
 */

import type { LiveAudio } from "./live-audio";

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
// than vertical travel so the pupils stay inside the painted sockets.
const SOCKET_RADIUS_X = 11.5;
const SOCKET_RADIUS_Y = 5.8;
const PURSUIT_TIME_CONSTANT_MS = 70;
const IDLE_AFTER_MOUSE_MS = 1500;
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
const MICRO_JITTER_RANGE_PX = 1.45;
const MICRO_JITTER_INTERVAL_RANGE_MS = [45, 115] as const;

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
  private leftEyeEl: HTMLElement | null;
  private rightEyeEl: HTMLElement | null;
  private headLightEl: HTMLElement | null;
  private debugCanvasEl: HTMLCanvasElement | null;
  private speakerCones: HTMLElement[];

  // Smoothed audio state used only for eye glow and head-light intensity.
  private bassEnv = 0;
  private midEnv = 0;
  private highEnv = 0;
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

  constructor() {
    // Transform the wrapper (head + eyes) so eyes stay pinned to the face
    // while the head breathes or tilts.
    this.headEl = document.getElementById("head-group");
    this.leftEarEl = document.querySelector("#eq-ear .ear-img");
    this.rightEarEl = document.querySelector("#pl-ear .ear-img");
    this.leftEarContainerEl = document.getElementById("eq-ear");
    this.rightEarContainerEl = document.getElementById("pl-ear");
    this.leftEyeEl = document.getElementById("alive-eye-left");
    this.rightEyeEl = document.getElementById("alive-eye-right");
    this.headLightEl = document.getElementById("alive-head-light");
    this.debugCanvasEl = document.getElementById("face-alive-debug") as HTMLCanvasElement | null;
    this.speakerCones = Array.from(document.querySelectorAll<HTMLElement>(".speaker-cone"));

    window.addEventListener("pointermove", this.handlePointerMove, { passive: true });
    document.addEventListener("mouseleave", this.handlePointerLeave, { passive: true });
    window.addEventListener("blur", this.handlePointerLeave, { passive: true });
  }

  setLiveAudio(la: LiveAudio | null) {
    this.liveAudio = la;
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
    this.resetEyeMotion(now);
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
    document.body.classList.remove("face-alive", "face-alive-debug");
    this.debugOverlayVisible = false;
    this.applyTransforms({
      headTx: 0,
      headTy: 0,
      headRotDeg: 0,
      eyeGlow: 1,
      openness: BLINK_MIN_OPENNESS,
      leftPupil: { x: 0, y: 0 },
      rightPupil: { x: 0, y: 0 },
      bassEnergy: 0,
      midEnergy: 0,
      highEnergy: 0,
      coneBreathe: 0,
      bodyBreath: 0,
    });
    this.clearDebugOverlay();
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

  private tick = () => {
    if (!this.active) return;
    const now = performance.now();
    const dtMs = Math.max(8, Math.min(40, now - this.lastTickAt || 16));
    this.lastTickAt = now;
    const elapsedSec = (now - this.startedAt) / 1000;

    let intensity = 0;
    let bassEnergyRaw = 0;
    let midEnergyRaw = 0;
    let highEnergyRaw = 0;
    if (this.liveAudio) {
      const fft = this.liveAudio.sample();
      if (fft) {
        bassEnergyRaw = bandEnergy(fft, 0.015, 0.1, 1.45);
        midEnergyRaw = bandEnergy(fft, 0.1, 0.38, 1.25);
        highEnergyRaw = bandEnergy(fft, 0.38, 0.78, 1.35);
      }
    }
    this.bassPeak = Math.max(bassEnergyRaw, this.bassPeak * BAND_PEAK_DECAY);
    this.midPeak = Math.max(midEnergyRaw, this.midPeak * BAND_PEAK_DECAY);
    this.highPeak = Math.max(highEnergyRaw, this.highPeak * BAND_PEAK_DECAY);

    this.bassEnv = smooth(this.bassEnv, normalizeEnergy(bassEnergyRaw, this.bassPeak), 0.38, 0.13);
    this.midEnv = smooth(this.midEnv, normalizeEnergy(midEnergyRaw, this.midPeak), 0.32, 0.12);
    this.highEnv = smooth(this.highEnv, normalizeEnergy(highEnergyRaw, this.highPeak), 0.42, 0.16);
    intensity = Math.min(1, this.bassEnv * 0.35 + this.midEnv * 0.45 + this.highEnv * 0.2);

    const bodyBreath = (Math.sin(elapsedSec * Math.PI * 2 * 0.82) + 1) * 0.5;
    const coneBreathBass = (Math.sin(elapsedSec * Math.PI * 2 * 1.55) + 1) * 0.5;
    const coneBreathMid = (Math.sin(elapsedSec * Math.PI * 2 * 1.95 + 1.7) + 1) * 0.5;
    const coneBreathHigh = (Math.sin(elapsedSec * Math.PI * 2 * 2.65 + 3.1) + 1) * 0.5;

    const bassEnergy = clamp01(0.18 + coneBreathBass * 0.22 + this.bassEnv * 0.56);
    const midEnergy = clamp01(0.14 + coneBreathMid * 0.18 + this.midEnv * 0.52);
    const highEnergy = clamp01(0.1 + coneBreathHigh * 0.2 + this.highEnv * 0.54);

    if (this.flourishMsLeft > 0) {
      this.flourishMsLeft = Math.max(0, this.flourishMsLeft - dtMs);
    }

    const eyeGlow = Math.min(1.45, 0.95 + intensity * 0.35);
    const openness = this.computeBlinkOpenness(now);
    const eyeMotion = this.computeEyeMotion(now, dtMs, elapsedSec);
    const headSway = Math.sin(elapsedSec * Math.PI * 2 * 0.28) * 0.42;
    const beatLean = (this.bassEnv - this.midEnv * 0.35) * 0.42;
    const headTx = headSway + beatLean;
    const headTy = bodyBreath * 0.34 + this.bassEnv * 0.2;
    const headRotDeg = Math.sin(elapsedSec * Math.PI * 2 * 0.22 + 0.9) * 0.32 + beatLean * 0.42;

    this.applyTransforms({
      headTx,
      headTy,
      headRotDeg,
      eyeGlow,
      openness,
      leftPupil: eyeMotion.left,
      rightPupil: eyeMotion.right,
      bassEnergy,
      midEnergy,
      highEnergy,
      coneBreathe: Math.max(coneBreathBass, coneBreathMid, coneBreathHigh),
      bodyBreath,
    });

    const mode = this.blink ? "blinking" : eyeMotion.mode;
    this.lastState = {
      leftOpenness: openness,
      rightOpenness: openness,
      leftPupil: { ...eyeMotion.left },
      rightPupil: { ...eyeMotion.right },
      mode,
    };
    if (this.debugOverlayVisible) this.drawDebugOverlay(eyeMotion.left, eyeMotion.right);

    this.rafHandle = requestAnimationFrame(this.tick);
  };

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
        const openT = (age - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
        this.openness = lerp(BLINK_MIN_OPENNESS, 1, easeInQuad(openT));
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
      this.nextBlinkAt = now + (wasForced ? 950 : randomRange(...BLINK_INTERVAL_RANGE_MS));
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

    const mouseRecentlyMoved = this.mouseInWindow && now - this.lastMouseMoveAt <= IDLE_AFTER_MOUSE_MS;
    const returningToCenter =
      !this.mouseInWindow && now - this.windowLeftAt >= 0 && now - this.windowLeftAt < WINDOW_RETURN_MS;

    if (mouseRecentlyMoved) {
      const mouseTargets = this.computeMouseTargets();
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

  private computeMouseTargets(): EyeTargets {
    const leftRect = this.leftEyeEl?.getBoundingClientRect();
    const rightRect = this.rightEyeEl?.getBoundingClientRect();
    if (!leftRect || !rightRect) {
      return { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    }

    const left = this.targetForRect(leftRect, this.mouseX, this.mouseY);
    const right = this.targetForRect(rightRect, this.mouseX, this.mouseY);
    const averageDistance =
      (distanceFromRectCenter(leftRect, this.mouseX, this.mouseY) +
        distanceFromRectCenter(rightRect, this.mouseX, this.mouseY)) /
      2;
    const convergence = clamp01(1 - averageDistance / 230) * 1.1;

    return {
      left: clampToSocket({ x: left.x + convergence, y: left.y }),
      right: clampToSocket({ x: right.x - convergence, y: right.y }),
    };
  }

  private targetForRect(rect: DOMRect, x: number, y: number): FaceAlivePupilState {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.max(1, Math.hypot(dx, dy));
    const pull = clamp01(dist / 170);
    return clampToSocket({
      x: (dx / dist) * SOCKET_RADIUS_X * pull,
      y: (dy / dist) * SOCKET_RADIUS_Y * pull,
    });
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
    const now = performance.now();
    const dt = now - this.lastPointerSampleAt;
    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    const moved = Math.hypot(dx, dy);

    this.mouseInWindow = true;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
    this.lastPointerSampleAt = now;

    if (moved > 0.5) this.lastMouseMoveAt = now;
    if (this.active && dt > 0 && dt < SACCADE_WINDOW_MS && moved > SACCADE_DISTANCE_PX) {
      this.saccadeRequested = true;
    }
  };

  private handlePointerLeave = () => {
    this.mouseInWindow = false;
    this.windowLeftAt = performance.now();
    this.saccadeRequested = false;
  };

  private applyTransforms(values: {
    headTx: number;
    headTy: number;
    headRotDeg: number;
    eyeGlow: number;
    openness: number;
    leftPupil: FaceAlivePupilState;
    rightPupil: FaceAlivePupilState;
    bassEnergy: number;
    midEnergy: number;
    highEnergy: number;
    coneBreathe: number;
    bodyBreath: number;
  }) {
    if (this.headEl) {
      this.headEl.style.transform = `translate(${values.headTx.toFixed(2)}px, ${values.headTy.toFixed(
        2,
      )}px) rotate(${values.headRotDeg.toFixed(3)}deg)`;
    }

    const earPulse = values.bassEnergy * 0.85 + values.midEnergy * 0.28;
    this.applyEarRecoil(this.leftEarContainerEl, this.leftEarEl, -earPulse, values.bodyBreath, true);
    this.applyEarRecoil(this.rightEarContainerEl, this.rightEarEl, earPulse, values.bodyBreath, false);
    this.applySpeakerCones(values.bassEnergy, values.midEnergy, values.highEnergy, values.coneBreathe);

    if (this.headLightEl) {
      const headLight = Math.min(
        1,
        0.35 + values.bodyBreath * 0.18 + values.bassEnergy * 0.28 + values.midEnergy * 0.34,
      );
      this.headLightEl.style.setProperty("--head-light", headLight.toFixed(3));
    }

    const lidClose = 1 - values.openness;
    const lidTopY = -9 + lidClose * 13;
    const lidBottomY = 5 - lidClose * 2;
    this.applyEyeVars(this.leftEyeEl, values.eyeGlow, values.openness, lidClose, lidTopY, lidBottomY, values.leftPupil);
    this.applyEyeVars(
      this.rightEyeEl,
      values.eyeGlow,
      values.openness,
      lidClose,
      lidTopY,
      lidBottomY,
      values.rightPupil,
    );
  }

  private applyEyeVars(
    eyeEl: HTMLElement | null,
    eyeGlow: number,
    openness: number,
    lidClose: number,
    lidTopY: number,
    lidBottomY: number,
    pupil: FaceAlivePupilState,
  ) {
    if (!eyeEl) return;
    const pupilOpacity = openness <= 0.18 ? 0 : clamp01((openness - 0.18) / 0.32);
    eyeEl.style.setProperty("--eye-glow", eyeGlow.toFixed(3));
    eyeEl.style.setProperty("--eye-beat", "0");
    eyeEl.style.setProperty("--blink-scale", openness.toFixed(3));
    eyeEl.style.setProperty("--lid-close", lidClose.toFixed(3));
    eyeEl.style.setProperty("--lid-top-y", `${lidTopY.toFixed(2)}px`);
    eyeEl.style.setProperty("--lid-bottom-y", `${lidBottomY.toFixed(2)}px`);
    eyeEl.style.setProperty("--eye-look-x", `${pupil.x.toFixed(2)}px`);
    eyeEl.style.setProperty("--eye-look-y", `${pupil.y.toFixed(2)}px`);
    eyeEl.style.setProperty("--pupil-opacity", pupilOpacity.toFixed(3));
  }

  private applySpeakerCones(bassEnergy: number, midEnergy: number, highEnergy: number, coneBreathe: number) {
    for (const cone of this.speakerCones) {
      const band = cone.dataset.band;
      const energy = band === "bass" ? bassEnergy : band === "mid" ? midEnergy : highEnergy;
      cone.style.setProperty("--cone-energy", energy.toFixed(3));
      cone.style.setProperty("--cone-beat", Math.max(0, bassEnergy - 0.7).toFixed(3));
      cone.style.setProperty("--cone-breathe", coneBreathe.toFixed(3));
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
      earImgEl.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${tilt.toFixed(
        3,
      )}deg)${mirror}`;
    }
  }

  private drawDebugOverlay(leftPupil: FaceAlivePupilState, rightPupil: FaceAlivePupilState) {
    const canvas = this.debugCanvasEl;
    const leftRect = this.leftEyeEl?.getBoundingClientRect();
    const rightRect = this.rightEyeEl?.getBoundingClientRect();
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
    ctx.ellipse(cx, cy, SOCKET_RADIUS_X, SOCKET_RADIUS_Y, 0, 0, Math.PI * 2);
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

function easeInQuad(t: number): number {
  const clamped = clamp01(t);
  return clamped * clamped;
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

function distanceFromRectCenter(rect: DOMRect, x: number, y: number): number {
  return Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
}

function clampToSocket(point: FaceAlivePupilState): FaceAlivePupilState {
  const normalized = Math.hypot(point.x / SOCKET_RADIUS_X, point.y / SOCKET_RADIUS_Y);
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
