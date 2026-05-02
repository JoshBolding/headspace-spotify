/**
 * Multi-mode face-screen visualizer.
 *
 * Driven by Spotify's Audio Analysis API since DRM blocks live FFT. We pull
 * segment loudness + pitch vectors, beats, and bars when a track loads, then
 * sample them at the current playback position to drive each mode's render.
 *
 * Modes: bars · radial · particles · rings · cover
 *
 * The vis-chooser button on the transport cycles modes; the choice is
 * persisted to localStorage so it survives restarts.
 */

import type { LiveAudio } from "./live-audio";
import { DEFAULT_PALETTE, type Palette } from "./palette";
import { STORAGE_KEYS } from "./storage-keys";

// Sized to match #vis-canvas in index.html. The CSS mask
// (head_inverse_mask.png, flood-filled from the cutout center) clips the
// canvas to the exact screen-interior shape, so we draw to a generous
// bounding box and let the mask handle the silhouette.
const W = 230;
const H = 175;

// Visualizer tuning. Pulled out as module-level constants so render code
// reads as intent ("BAR_COUNT" rather than "28") and so tuning is one place.
const BAR_COUNT = 28;
const RADIAL_BAND_COUNT = 48;
const RING_LIFETIME_MS = 1100;
const RING_MAX_RADIUS_PX = 110;
const PARTICLE_TRAIL_INTENSITY_THRESHOLD = 0.08;
const FLASH_DECAY_PER_FRAME = 0.88;
const PEAK_DECAY_PER_FRAME_PX = 1.6;

interface Segment {
  start: number;
  duration: number;
  loudness_max: number;
  pitches: number[];
}
interface Interval {
  start: number;
  duration: number;
  confidence: number;
}
interface Analysis {
  segments: Segment[];
  beats: Interval[];
  bars: Interval[];
  track: { tempo: number; loudness: number };
}

export type VisMode =
  | "bars"
  | "radial"
  | "particles"
  | "rings"
  | "spectro"
  | "cover";
export const VIS_MODES: VisMode[] = [
  "bars",
  "radial",
  "particles",
  "rings",
  "spectro",
  "cover",
];

const VIS_MODE_LABEL: Record<VisMode, string> = {
  bars: "Bars",
  radial: "Radial",
  particles: "Particles",
  rings: "Rings",
  spectro: "Spectrogram",
  cover: "Cover Art",
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 0..1, decays
  hue: number;
  size: number;
}

interface Ring {
  bornAt: number;
  intensity: number;
}

export class Visualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private artImg: HTMLImageElement | null = null;
  private artLoaded = false;
  private isPlaying = false;
  private positionMs = 0;
  private analysis: Analysis | null = null;
  private liveAudio: LiveAudio | null = null;
  private palette: Palette = DEFAULT_PALETTE;
  // Cached numeric channels for the active palette so per-frame draw routines
  // (radial, spectro) don't re-parse `rgb(r,g,b)` strings 60×/sec. Repopulated
  // from setPalette().
  private paletteRgb: {
    primary: [number, number, number];
    secondary: [number, number, number];
    highlight: [number, number, number];
  } = {
    primary: parseRgb(DEFAULT_PALETTE.primary),
    secondary: parseRgb(DEFAULT_PALETTE.secondary),
    highlight: parseRgb(DEFAULT_PALETTE.highlight),
  };
  private mode: VisMode = "bars";

  // Cached lookup state
  private lastSegIndex = 0;
  private lastBeatIndex = -1;
  private lastBarIndex = -1;

  // Per-band peak hold for bars mode
  private peaks: number[] = [];

  // Effects state
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private flashAt = 0;
  private barFlashIntensity = 0;

  // Scrolling spectrogram buffer — one offscreen canvas, blit + shift each
  // frame. Avoids re-rendering the full history per frame.
  private spectroCanvas: HTMLCanvasElement | null = null;
  private spectroCtx: CanvasRenderingContext2D | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = canvas.getContext("2d")!;
    this.mode = (localStorage.getItem(STORAGE_KEYS.vizMode) as VisMode) || "bars";
    if (!VIS_MODES.includes(this.mode)) this.mode = "bars";
    this.startLoop();
  }

  // -------- public API --------

  setCoverArt(url: string | null) {
    if (!url) {
      this.artImg = null;
      this.artLoaded = false;
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.artImg = img;
      this.artLoaded = true;
    };
    img.src = url;
  }

  setAnalysis(analysis: Analysis | null) {
    this.analysis = analysis;
    this.lastSegIndex = 0;
    this.lastBeatIndex = -1;
    this.lastBarIndex = -1;
    this.peaks = [];
    this.particles = [];
    this.rings = [];
    if (this.spectroCtx && this.spectroCanvas) {
      this.spectroCtx.clearRect(0, 0, this.spectroCanvas.width, this.spectroCanvas.height);
    }
  }

  /** Attach a live FFT source. When set, takes precedence over Analysis data. */
  setLiveAudio(la: LiveAudio | null) {
    this.liveAudio = la;
  }

  /** Set the active color palette (typically extracted from album art). */
  setPalette(p: Palette) {
    this.palette = p;
    this.paletteRgb = {
      primary: parseRgb(p.primary),
      secondary: parseRgb(p.secondary),
      highlight: parseRgb(p.highlight),
    };
  }

  setPlaying(playing: boolean) {
    this.isPlaying = playing;
  }

  setPosition(ms: number) {
    this.positionMs = ms;
  }

  setMode(mode: VisMode) {
    if (!VIS_MODES.includes(mode)) return;
    this.mode = mode;
    localStorage.setItem(STORAGE_KEYS.vizMode, mode);
  }

  cycleMode(): VisMode {
    const i = VIS_MODES.indexOf(this.mode);
    const next = VIS_MODES[(i + 1) % VIS_MODES.length];
    this.setMode(next);
    return next;
  }

  getMode(): VisMode {
    return this.mode;
  }

  static labelFor(mode: VisMode): string {
    return VIS_MODE_LABEL[mode];
  }

  // -------- render loop --------

  private startLoop() {
    const tick = () => {
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private draw() {
    const g = this.ctx;
    g.fillStyle = "#0d2410";
    g.fillRect(0, 0, W, H);

    // Subtle cover art behind every non-cover mode for warmth.
    if (this.mode !== "cover" && this.artLoaded && this.artImg) {
      this.drawCoverBackground(0.18);
    }

    // Prefer live FFT (real audio) over Analysis (synthetic or fetched).
    // Single sample() per frame — both bands and intensity reuse it.
    // Gate on isPlaying: loopback captures all system audio, so without
    // this check, Netflix/Discord/etc would drive the viz when Spotify is
    // paused. When paused, we treat live audio as absent → modes fall back
    // to their idle/synthetic state. Imperfect (still picks up other
    // sources during simultaneous Spotify+Netflix playback), but covers
    // the common "Spotify paused, other audio playing" case.
    const liveFft = this.isPlaying && this.liveAudio ? this.liveAudio.sample() : null;
    const useLive = liveFft !== null;
    let liveIntensity = 0;
    let liveBeat = false;
    let liveOnset = false;
    if (useLive) {
      let mid = 0;
      const lo = Math.floor(liveFft!.length * 0.05);
      const hi = Math.floor(liveFft!.length * 0.4);
      for (let i = lo; i < hi; i++) mid += liveFft![i];
      liveIntensity = mid / (hi - lo) / 255;
      liveBeat = this.liveAudio!.checkBeat();
      liveOnset = this.liveAudio!.checkOnset();
    }

    const positionSec = this.positionMs / 1000;
    const seg = useLive ? null : this.findSegment(positionSec);
    const beatHit = useLive ? liveBeat : this.checkBeatHit(positionSec);
    const intensity = useLive
      ? liveIntensity
      : seg
        ? loudnessToLinear(seg.loudness_max)
        : 0;

    if (beatHit) this.barFlashIntensity = 1;
    // Onsets give a smaller flash so non-bass-heavy parts still pulse.
    else if (liveOnset)
      this.barFlashIntensity = Math.max(this.barFlashIntensity, 0.4);

    const fftForBands = liveFft;
    switch (this.mode) {
      case "bars":
        this.drawBars(seg, intensity, beatHit, fftForBands);
        break;
      case "radial":
        this.drawRadial(seg, intensity, beatHit, fftForBands);
        break;
      case "particles":
        this.drawParticles(intensity, beatHit, liveOnset, useLive);
        break;
      case "rings":
        this.drawRings(beatHit, intensity, liveOnset, useLive);
        break;
      case "spectro":
        this.drawSpectro(fftForBands);
        break;
      case "cover":
        this.drawCover();
        break;
    }

    // Decay flash
    this.barFlashIntensity *= FLASH_DECAY_PER_FRAME;

    // Scanlines for skin coherence (skip for cover which has its own treatment)
    if (this.mode !== "cover") {
      g.fillStyle = "rgba(0, 0, 0, 0.10)";
      for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1);
    }
  }

  private drawCoverBackground(alpha: number) {
    if (!this.artImg) return;
    const ar = this.artImg.width / this.artImg.height;
    const targetAr = W / H;
    let dw = W,
      dh = H,
      dx = 0,
      dy = 0;
    if (ar > targetAr) {
      dh = H;
      dw = H * ar;
      dx = (W - dw) / 2;
    } else {
      dw = W;
      dh = W / ar;
      dy = (H - dh) / 2;
    }
    const g = this.ctx;
    g.save();
    g.globalAlpha = alpha;
    g.filter = "saturate(0.5) brightness(0.6) blur(1px)";
    g.drawImage(this.artImg, dx, dy, dw, dh);
    g.restore();
    g.fillStyle = "rgba(40, 95, 3, 0.20)";
    g.fillRect(0, 0, W, H);
  }

  // -------- mode: bars --------

  private drawBars(
    seg: Segment | null,
    intensity: number,
    beatHit: boolean,
    fft: Uint8Array | null,
  ) {
    const g = this.ctx;
    const N = BAR_COUNT;
    const gap = 1;
    const barW = (W - gap * (N + 1)) / N;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, this.palette.primary);
    grad.addColorStop(1, this.palette.secondary);

    if (this.peaks.length !== N) this.peaks = new Array(N).fill(0);

    const heights = fft ? fftToBands(fft, N) : computeBands(seg, intensity, N);

    for (let i = 0; i < N; i++) {
      const v = heights[i];
      const barH = Math.max(2, v * (H - 8));
      const x = gap + i * (barW + gap);
      const y = H - barH;
      g.fillStyle = grad;
      g.fillRect(x, y, barW, barH);

      const decayed = Math.max(0, this.peaks[i] - PEAK_DECAY_PER_FRAME_PX);
      const peak = barH > decayed ? barH : decayed;
      this.peaks[i] = peak;
      g.fillStyle = this.palette.highlight;
      g.fillRect(x, H - peak - 2, barW, 2);
    }

    if (beatHit) {
      g.fillStyle = `rgba(255, 255, 255, ${0.18 * this.barFlashIntensity})`;
      g.fillRect(0, 0, W, H);
    }
  }

  // -------- mode: radial --------

  private drawRadial(
    seg: Segment | null,
    intensity: number,
    beatHit: boolean,
    fft: Uint8Array | null,
  ) {
    const g = this.ctx;
    const cx = W / 2;
    const cy = H / 2;
    const N = RADIAL_BAND_COUNT;
    const innerR = 18 + (beatHit ? 6 * this.barFlashIntensity : 0);
    const heights = fft ? fftToBands(fft, N) : computeBands(seg, intensity, N);
    const sec = this.paletteRgb.secondary;
    const pri = this.paletteRgb.primary;
    g.save();
    g.translate(cx, cy);
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
      const len = 4 + heights[i] * 36;
      const x1 = Math.cos(angle) * innerR;
      const y1 = Math.sin(angle) * innerR;
      const x2 = Math.cos(angle) * (innerR + len);
      const y2 = Math.sin(angle) * (innerR + len);
      const t = heights[i];
      // Lerp secondary → primary along band intensity.
      const r = Math.floor(sec[0] + (pri[0] - sec[0]) * t);
      const gC = Math.floor(sec[1] + (pri[1] - sec[1]) * t);
      const b = Math.floor(sec[2] + (pri[2] - sec[2]) * t);
      g.strokeStyle = `rgb(${r}, ${gC}, ${b})`;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    // Center dot pulsed by beat flash.
    g.fillStyle = withAlpha(this.palette.primary, 0.4 + 0.5 * this.barFlashIntensity);
    g.beginPath();
    g.arc(0, 0, 3 + 4 * this.barFlashIntensity, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // -------- mode: particles --------

  private drawParticles(
    intensity: number,
    beatHit: boolean,
    onset: boolean,
    useLive: boolean,
  ) {
    const g = this.ctx;
    if (beatHit) this.spawnParticles(intensity);
    else if (onset) this.spawnParticles(intensity * 0.5);
    // Continuous low-rate spawn driven by intensity — keeps particles alive
    // through quiet/non-percussive sections instead of dying off entirely.
    if (useLive && intensity > PARTICLE_TRAIL_INTENSITY_THRESHOLD) {
      const continuous = Math.floor(intensity * 4);
      for (let i = 0; i < continuous; i++) {
        if (Math.random() < 0.4) this.spawnTrailParticle(intensity);
      }
    }
    // Trail effect
    g.fillStyle = "rgba(13, 36, 16, 0.35)";
    g.fillRect(0, 0, W, H);

    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02; // gentle gravity
      p.life -= 0.012;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    for (const p of this.particles) {
      g.fillStyle = `hsla(${p.hue}, 80%, 65%, ${p.life})`;
      g.beginPath();
      g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      g.fill();
    }
  }

  private spawnTrailParticle(intensity: number) {
    const cx = W / 2 + (Math.random() - 0.5) * W * 0.6;
    const cy = H / 2 + (Math.random() - 0.5) * H * 0.4;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.4 + Math.random() * 1.2;
    this.particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 0.3,
      life: 0.45 + Math.random() * 0.3,
      hue: this.palette.primaryHueDeg + (Math.random() - 0.5) * 30,
      size: 0.8 + Math.random() * 1.0 + intensity * 0.6,
    });
  }

  private spawnParticles(intensity: number) {
    const count = Math.max(8, Math.floor(8 + intensity * 22));
    const cx = W / 2;
    const cy = H / 2 + 6;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.6 + Math.random() * 3.2 * (0.5 + intensity);
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 4,
        y: cy + (Math.random() - 0.5) * 4,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.7 + Math.random() * 0.4,
        hue: this.palette.primaryHueDeg + (Math.random() - 0.5) * 40,
        size: 1.4 + Math.random() * 1.6,
      });
    }
  }

  // -------- mode: rings --------

  private drawRings(
    beatHit: boolean,
    intensity: number,
    onset: boolean,
    useLive: boolean,
  ) {
    const g = this.ctx;
    if (beatHit) {
      this.rings.push({ bornAt: performance.now(), intensity });
      if (this.rings.length > 12) this.rings.shift();
    } else if (onset) {
      // Onsets emit a smaller, lower-intensity ring — visible activity for
      // hi-hats / vocals between bass beats.
      this.rings.push({ bornAt: performance.now(), intensity: intensity * 0.45 });
      if (this.rings.length > 12) this.rings.shift();
    } else if (useLive && intensity > 0.15 && Math.random() < intensity * 0.08) {
      // Random low-frequency ring spawn during sustained energy — keeps the
      // mode visually alive even when the onset detector is quiet.
      this.rings.push({ bornAt: performance.now(), intensity: intensity * 0.3 });
      if (this.rings.length > 12) this.rings.shift();
    }
    const cx = W / 2;
    const cy = H / 2;
    const now = performance.now();
    g.save();
    for (const ring of this.rings) {
      const age = (now - ring.bornAt) / RING_LIFETIME_MS;
      if (age >= 1) continue;
      const radius = age * RING_MAX_RADIUS_PX;
      const alpha = (1 - age) * (0.35 + ring.intensity * 0.5);
      g.strokeStyle = withAlpha(this.palette.primary, alpha);
      g.lineWidth = 2 - age * 1.6;
      g.beginPath();
      g.arc(cx, cy, radius, 0, Math.PI * 2);
      g.stroke();
    }
    this.rings = this.rings.filter((r) => (now - r.bornAt) < RING_LIFETIME_MS);
    // Center pulse
    const pulseRadius = 4 + 8 * this.barFlashIntensity;
    g.fillStyle = withAlpha(this.palette.highlight, 0.4 + 0.5 * this.barFlashIntensity);
    g.beginPath();
    g.arc(cx, cy, pulseRadius, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // -------- mode: spectro (scrolling waterfall) --------

  private drawSpectro(fft: Uint8Array | null) {
    const g = this.ctx;
    if (!this.spectroCanvas) {
      this.spectroCanvas = document.createElement("canvas");
      this.spectroCanvas.width = W;
      this.spectroCanvas.height = H;
      this.spectroCtx = this.spectroCanvas.getContext("2d");
    }
    const sc = this.spectroCtx!;
    const buf = this.spectroCanvas!;
    // Shift one column left, exposing the right column to draw the new slice.
    sc.drawImage(buf, -1, 0);
    sc.clearRect(W - 1, 0, 1, H);

    if (fft) {
      const pri = this.paletteRgb.primary;
      const sec = this.paletteRgb.secondary;
      // Use the lower 60% of bins, log-mapped onto H. Color = secondary→primary
      // gradient by magnitude, with brightness = magnitude.
      const usable = Math.floor(fft.length * 0.6);
      for (let y = 0; y < H; y++) {
        // Bottom of screen = bass, top = treble.
        const t = 1 - y / H;
        const bin = Math.floor(Math.pow(t, 1.7) * usable);
        const m = fft[bin] / 255;
        const r = Math.floor(sec[0] + (pri[0] - sec[0]) * m);
        const gC = Math.floor(sec[1] + (pri[1] - sec[1]) * m);
        const b = Math.floor(sec[2] + (pri[2] - sec[2]) * m);
        // Multiply by m for brightness so quiet bins fade toward black.
        sc.fillStyle = `rgba(${r}, ${gC}, ${b}, ${0.15 + m * 0.85})`;
        sc.fillRect(W - 1, y, 1, 1);
      }
    } else {
      // No FFT — draw a thin idle stripe so the mode is recognizable.
      sc.fillStyle = withAlpha(this.palette.secondary, 0.4);
      sc.fillRect(W - 1, H / 2 - 1, 1, 2);
    }
    g.drawImage(buf, 0, 0);
  }

  // -------- mode: cover --------

  private drawCover() {
    const g = this.ctx;
    if (!this.artLoaded || !this.artImg) {
      g.fillStyle = "rgba(120, 220, 60, 0.12)";
      const t = performance.now() / 1000;
      const offsetY = Math.sin(t * 1.5) * 6;
      g.fillRect(0, H / 2 + offsetY - 1, W, 2);
      return;
    }
    const ar = this.artImg.width / this.artImg.height;
    const targetAr = W / H;
    let dw = W,
      dh = H,
      dx = 0,
      dy = 0;
    if (ar > targetAr) {
      dh = H;
      dw = H * ar;
      dx = (W - dw) / 2;
    } else {
      dw = W;
      dh = W / ar;
      dy = (H - dh) / 2;
    }
    const pulse = this.isPlaying ? 1 + 0.012 * Math.sin(performance.now() / 380) : 1;
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(pulse, pulse);
    g.translate(-W / 2, -H / 2);
    g.filter = "saturate(0.7) brightness(0.82)";
    g.drawImage(this.artImg, dx, dy, dw, dh);
    g.restore();
    g.fillStyle = "rgba(40, 95, 3, 0.16)";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(0, 0, 0, 0.13)";
    for (let y = 0; y < H; y += 2) g.fillRect(0, y, W, 1);
  }

  // -------- analysis lookup --------

  private findSegment(positionSec: number): Segment | null {
    if (!this.analysis) return null;
    const segs = this.analysis.segments;
    if (!segs.length) return null;
    // Try cached index first (fast path: position advanced one segment).
    let i = this.lastSegIndex;
    if (i < 0 || i >= segs.length) i = 0;
    while (i < segs.length && segs[i].start + segs[i].duration < positionSec) i++;
    while (i > 0 && segs[i - 1].start > positionSec) i--;
    this.lastSegIndex = Math.max(0, Math.min(segs.length - 1, i));
    const s = segs[this.lastSegIndex];
    return s ?? null;
  }

  private checkBeatHit(positionSec: number): boolean {
    if (!this.analysis) return false;
    const beats = this.analysis.beats;
    if (!beats.length) return false;
    let i = this.lastBeatIndex;
    if (i < 0) i = 0;
    while (i < beats.length && beats[i].start <= positionSec) {
      if (i !== this.lastBeatIndex) {
        this.lastBeatIndex = i;
        return true;
      }
      i++;
    }
    this.lastBeatIndex = i - 1;
    return false;
  }
}

/**
 * Parse `rgb(r, g, b)` into a [r,g,b] tuple. The palette stores its colors
 * in this format so that `withAlpha` and the radial-gradient interpolation
 * can operate on numeric channels.
 */
function parseRgb(s: string): [number, number, number] {
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return [200, 255, 94];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Wrap an `rgb(...)` palette color into `rgba(...)` with the given alpha. */
function withAlpha(s: string, alpha: number): string {
  const [r, g, b] = parseRgb(s);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Bin a live FFT snapshot into N visual bands across the audible range
 * (rough log spacing — first bins get their own band, higher bins get
 * grouped). Returns 0..1 normalized heights.
 */
function fftToBands(fft: Uint8Array, N: number): number[] {
  const out = new Array(N).fill(0);
  // Use the first ~60% of bins — the top end is mostly noise and air.
  const usable = Math.floor(fft.length * 0.6);
  // Log-ish spacing: pow(i/N, 1.7) clusters bands toward the bass end.
  for (let i = 0; i < N; i++) {
    const t0 = Math.floor(Math.pow(i / N, 1.7) * usable);
    const t1 = Math.max(t0 + 1, Math.floor(Math.pow((i + 1) / N, 1.7) * usable));
    let sum = 0;
    let count = 0;
    for (let b = t0; b < t1 && b < fft.length; b++) {
      sum += fft[b];
      count++;
    }
    const v = count > 0 ? sum / count / 255 : 0;
    // Slight upward curve so quiet passages aren't completely flat.
    out[i] = Math.min(1, Math.pow(v, 0.85) * 1.15);
  }
  return out;
}

/**
 * Build a fake Analysis when Spotify's /audio-analysis is unavailable
 * (deprecated for new apps as of Nov 2024). Beats won't sync to the actual
 * music, but the visualizers animate rhythmically instead of sitting dead.
 */
export function buildSyntheticAnalysis(
  durationMs: number,
  tempoBpm = 120,
): Analysis {
  const totalSec = Math.max(1, durationMs / 1000);
  const beatDur = 60 / tempoBpm;
  const segDur = beatDur / 2; // two segments per beat
  const segments: Segment[] = [];
  for (let t = 0; t < totalSec; t += segDur) {
    // Loudness wobbles between ~-30 and ~-8 dB on an 8s cycle.
    const phase = (t / 8) * Math.PI * 2;
    const loudness_max = -19 + 11 * Math.sin(phase);
    // Pitch chroma rotates over time so bars/radial don't look static.
    const pitches: number[] = [];
    for (let i = 0; i < 12; i++) {
      const v = 0.5 + 0.5 * Math.sin(phase * 0.7 + i * 0.6 + t * 0.3);
      pitches.push(v);
    }
    segments.push({ start: t, duration: segDur, loudness_max, pitches });
  }
  const beats: Interval[] = [];
  for (let t = 0; t < totalSec; t += beatDur) {
    beats.push({ start: t, duration: beatDur, confidence: 0.8 });
  }
  const bars: Interval[] = [];
  const barDur = beatDur * 4;
  for (let t = 0; t < totalSec; t += barDur) {
    bars.push({ start: t, duration: barDur, confidence: 0.8 });
  }
  return { segments, beats, bars, track: { tempo: tempoBpm, loudness: -14 } };
}

/** Convert dB-ish loudness (~ -60 .. 0) to a 0..1 linear factor. */
function loudnessToLinear(db: number): number {
  // Spotify's loudness_max is roughly -60 to 0 dB. Map to 0..1 with a knee.
  const norm = Math.max(0, Math.min(1, (db + 60) / 60));
  return Math.pow(norm, 1.4);
}

/**
 * Build N bar heights from a segment's pitch vector + loudness intensity.
 * Pitch vector is 12 elements (chroma); we interpolate to N and weight by
 * intensity so loud segments produce taller bars.
 */
function computeBands(seg: Segment | null, intensity: number, N: number): number[] {
  const out = new Array(N).fill(0);
  if (!seg || !seg.pitches || !seg.pitches.length) return out;
  const pitches = seg.pitches;
  for (let i = 0; i < N; i++) {
    const t = (i / (N - 1)) * (pitches.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(pitches.length - 1, lo + 1);
    const frac = t - lo;
    const p = pitches[lo] * (1 - frac) + pitches[hi] * frac;
    // Scale by intensity, with a touch of base level so bars never fully die.
    out[i] = Math.min(1, 0.06 + p * (0.55 + intensity * 0.85));
  }
  return out;
}
