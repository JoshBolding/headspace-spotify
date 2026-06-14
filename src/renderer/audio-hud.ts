/**
 * AudioHud — a live diagnostic overlay for the audio-reactive pipeline.
 *
 * The whole "alive" experience (speaker cones, beat-bumped eyes, drop
 * reactions, Milkdrop) is driven by LiveAudio. But capture is fragile:
 * Spotify's DRM usually blocks the direct tap, so we fall back to system
 * loopback — which can report a healthy "source" while actually delivering
 * silence (wrong output device, muted capture, nothing playing yet).
 *
 * This HUD makes the invisible visible: current source, live low/mid/high
 * band levels, and whether beats/onsets/drops are firing. Toggle with
 * Ctrl+Shift+A. If the bars move with the music, the chain works; if the
 * source says loopback but the bars are flat, capture is the problem.
 */

import type { LiveAudio } from "./live-audio";

interface BandDef {
  label: string;
  lo: number; // fraction of spectrum
  hi: number;
  gain: number;
}

const BANDS: BandDef[] = [
  { label: "LOW", lo: 0.015, hi: 0.1, gain: 1.45 },
  { label: "MID", lo: 0.1, hi: 0.38, gain: 1.25 },
  { label: "HI", lo: 0.38, hi: 0.78, gain: 1.35 },
];

export class AudioHud {
  private root: HTMLElement;
  private srcEl: HTMLElement;
  private bars: HTMLElement[] = [];
  private barFills: HTMLElement[] = [];
  private beatDot: HTMLElement;
  private onsetDot: HTMLElement;
  private dropDot: HTMLElement;
  private rmsEl: HTMLElement;
  private surgeFill!: HTMLElement;
  private surgePeak!: HTMLElement;
  private surgeThresh!: HTMLElement;
  private liveAudio: LiveAudio | null = null;
  private rafHandle: number | null = null;
  private visible = false;
  private beatFlash = 0;
  private onsetFlash = 0;
  private dropFlash = 0;
  private surgePeakFrac = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "audio-hud";
    this.root.dataset.opaque = "1";
    this.root.innerHTML = `
      <div class="ah-row ah-head">
        <span class="ah-title">AUDIO</span>
        <span class="ah-src">—</span>
      </div>
      <div class="ah-meters"></div>
      <div class="ah-meter ah-surge-meter">
        <span class="ah-meter-label">SRG</span>
        <span class="ah-bar">
          <span class="ah-bar-fill ah-surge-fill"></span>
          <span class="ah-surge-peak"></span>
          <span class="ah-surge-thresh"></span>
        </span>
      </div>
      <div class="ah-row ah-flags">
        <span class="ah-dot ah-beat">BEAT</span>
        <span class="ah-dot ah-onset">ONSET</span>
        <span class="ah-dot ah-drop">DROP</span>
      </div>
      <div class="ah-row ah-rms"><span class="ah-rms-val">—</span></div>
    `;
    parent.appendChild(this.root);
    this.srcEl = this.root.querySelector(".ah-src")!;
    this.beatDot = this.root.querySelector(".ah-beat")!;
    this.onsetDot = this.root.querySelector(".ah-onset")!;
    this.dropDot = this.root.querySelector(".ah-drop")!;
    this.rmsEl = this.root.querySelector(".ah-rms-val")!;
    this.surgeFill = this.root.querySelector(".ah-surge-fill")!;
    this.surgePeak = this.root.querySelector(".ah-surge-peak")!;
    this.surgeThresh = this.root.querySelector(".ah-surge-thresh")!;

    const meters = this.root.querySelector(".ah-meters")!;
    for (const band of BANDS) {
      const row = document.createElement("div");
      row.className = "ah-meter";
      row.innerHTML = `<span class="ah-meter-label">${band.label}</span><span class="ah-bar"><span class="ah-bar-fill"></span></span>`;
      meters.appendChild(row);
      this.bars.push(row);
      this.barFills.push(row.querySelector(".ah-bar-fill")!);
    }
  }

  setLiveAudio(la: LiveAudio | null): void {
    this.liveAudio = la;
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.classList.add("show");
    const loop = () => {
      this.tick();
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  hide(): void {
    this.visible = false;
    this.root.classList.remove("show");
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  private tick(): void {
    const src = this.liveAudio?.getSource() ?? null;
    this.srcEl.textContent = src ? src.toUpperCase() : "SYNTHETIC / NONE";
    this.srcEl.className = `ah-src ${src ? "ah-src-live" : "ah-src-none"}`;

    const fft = this.liveAudio?.sample() ?? null;
    let total = 0;
    if (fft) {
      for (let i = 0; i < fft.length; i++) total += fft[i];
    }
    const rms = fft ? total / fft.length / 255 : 0;

    for (let i = 0; i < BANDS.length; i++) {
      const band = BANDS[i];
      let v = 0;
      if (fft) {
        const lo = Math.max(0, Math.floor(fft.length * band.lo));
        const hi = Math.min(fft.length, Math.max(lo + 1, Math.floor(fft.length * band.hi)));
        let sum = 0;
        for (let b = lo; b < hi; b++) sum += fft[b];
        v = Math.min(1, (sum / (hi - lo) / 255) * band.gain);
      }
      this.barFills[i].style.width = `${Math.round(v * 100)}%`;
    }

    if (this.liveAudio) {
      if (this.liveAudio.checkBeat()) this.beatFlash = 1;
      if (this.liveAudio.checkOnset()) this.onsetFlash = 1;
      if (this.liveAudio.checkDrop()) this.dropFlash = 1;

      // Surge meter: threshold sits at the bar's midpoint so overshoot past it
      // (= a drop) is visible. Peak-hold shows how high the last surge reached.
      const m = this.liveAudio.getDropMetrics();
      const frac = m.threshold > 0 ? Math.min(1, m.surge / (m.threshold * 2)) : 0;
      this.surgeThresh.style.left = "50%";
      this.surgeFill.style.width = `${Math.round(frac * 100)}%`;
      this.surgeFill.classList.toggle("over", m.surge >= m.threshold);
      this.surgePeakFrac = Math.max(frac, this.surgePeakFrac - 0.01);
      this.surgePeak.style.left = `${Math.round(this.surgePeakFrac * 100)}%`;
    }
    this.beatDot.classList.toggle("lit", this.beatFlash > 0.5);
    this.onsetDot.classList.toggle("lit", this.onsetFlash > 0.5);
    this.dropDot.classList.toggle("lit", this.dropFlash > 0.5);
    this.beatFlash *= 0.8;
    this.onsetFlash *= 0.8;
    this.dropFlash *= 0.86;

    const pct = Math.round(rms * 100);
    this.rmsEl.textContent =
      fft && rms > 0.002 ? `signal ${pct}%` : "— no signal —";
    this.rmsEl.classList.toggle("ah-silent", !(fft && rms > 0.002));
  }
}
