/**
 * Live audio FFT source for the visualizer.
 *
 * Two paths, in order of preference:
 *
 *  1. **Tap**: AnalyserNode hooked into the Spotify SDK's <audio> element.
 *     Free, no permission prompt. Usually returns silence under EME/Widevine
 *     because the decrypted PCM never reaches WebAudio — but the Castlabs
 *     Electron build sometimes routes audio in a way that lets it through,
 *     so it's worth probing.
 *
 *  2. **Loopback**: getDisplayMedia({ audio: true }) — Windows lets the user
 *     pick "Entire Screen" with system audio shared. Captures whatever's
 *     playing on the speakers, post-DRM. Requires a user gesture and a one-
 *     time permission prompt. Captures ALL system audio, not just Spotify.
 *
 * If neither path produces data, the visualizer falls back to its synthetic
 * 120-BPM analysis (in visualizer.ts).
 */

export type LiveAudioSource = "tap" | "loopback";

export class LiveAudio {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private panner: StereoPannerNode | null = null;
  private freq: Uint8Array | null = null;
  private src: LiveAudioSource | null = null;

  // Spectral-flux onset detector state. Flux = sum of positive bin-deltas
  // between consecutive frames — a much tighter onset signal than raw energy.
  private prevSpectrum: Uint8Array | null = null;
  private fluxHistory: number[] = [];
  private lastFluxBeatAt = 0;
  private lastFluxOnsetAt = 0;

  getSource(): LiveAudioSource | null {
    return this.src;
  }

  /**
   * Whether stereo balance can actually be applied. Only true when the tap
   * path succeeded — loopback captures audio post-mix and can't pan it back
   * into the playback path, and synthetic has no audio at all.
   */
  canPan(): boolean {
    return this.panner !== null;
  }

  /** Set stereo balance from -1 (full left) to +1 (full right). No-op if no panner. */
  setPan(value: number): void {
    if (!this.panner) return;
    const v = Math.max(-1, Math.min(1, value));
    this.panner.pan.setTargetAtTime(v, this.panner.context.currentTime, 0.01);
  }

  /**
   * Probe path 1: tap the SDK's audio element. Resolves true if non-zero
   * samples flow within ~800ms of probing.
   */
  async tryTap(): Promise<boolean> {
    const audioEl = document.querySelector("audio") as HTMLAudioElement | null;
    if (!audioEl) return false;
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const source = ctx.createMediaElementSource(audioEl);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      // Insert a StereoPannerNode in the chain so we can drive balance from
      // the renderer if (rare!) tap succeeds. source → analyser → panner → dest.
      const panner = ctx.createStereoPanner();
      source.connect(analyser);
      analyser.connect(panner);
      panner.connect(ctx.destination);

      const buf = new Uint8Array(analyser.frequencyBinCount);
      // Sample a few times across ~800ms before declaring silence — first
      // frames after construction are always zero even with a live source.
      const t0 = performance.now();
      while (performance.now() - t0 < 800) {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        if (sum > 0) {
          this.ctx = ctx;
          this.analyser = analyser;
          this.panner = panner;
          this.freq = buf;
          this.src = "tap";
          return true;
        }
        await sleep(80);
      }
      // Silent — likely DRM blocked. Tear down and fail.
      await ctx.close();
      return false;
    } catch (err) {
      console.warn("[live-audio] tap setup failed:", err);
      if (ctx) await ctx.close().catch(() => undefined);
      return false;
    }
  }

  /**
   * Probe path 2: WASAPI loopback via Electron's desktopCapturer. The main
   * process hands us a screen source ID; we feed it to getUserMedia with
   * the legacy `chromeMediaSource: 'desktop'` constraint. On Windows this
   * captures system-audio loopback. Doesn't require a user gesture (unlike
   * getDisplayMedia), so we can call it automatically on startup.
   */
  async tryLoopback(): Promise<boolean> {
    let stream: MediaStream | null = null;
    try {
      const sourceId = await window.headspace.getLoopbackSourceId();
      if (!sourceId) {
        console.warn("[live-audio] no screen source available for loopback");
        return false;
      }
      // The mandatory constraint shape is Electron-specific; cast through
      // unknown to satisfy the standard MediaTrackConstraints type.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        } as unknown as MediaTrackConstraints,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
          },
        } as unknown as MediaTrackConstraints,
      });
      // We only want the audio. Stop the video tracks immediately so the
      // capture pipeline doesn't burn CPU encoding screen frames.
      stream.getVideoTracks().forEach((t) => t.stop());
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        console.warn("[live-audio] loopback returned no audio tracks");
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const ctx = new AudioContext();
      const audioOnlyStream = new MediaStream(audioTracks);
      const source = ctx.createMediaStreamSource(audioOnlyStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      // Do NOT connect to destination — we'd echo the system audio back out.

      this.ctx = ctx;
      this.analyser = analyser;
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.src = "loopback";
      return true;
    } catch (err) {
      console.warn("[live-audio] loopback failed:", err);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      return false;
    }
  }

  /** Pull the latest frequency snapshot. Returns null if no source active. */
  sample(): Uint8Array | null {
    if (!this.analyser || !this.freq) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  /**
   * Per-frame spectral-flux update. Computes the positive bin-delta sum
   * between this frame and the previous one — an industry-standard onset
   * function. Both `checkBeat` and `checkOnset` consume the rolling history
   * this maintains. Call once per render frame, before checkBeat/checkOnset.
   *
   * Spectral flux catches percussive transients much earlier than RMS
   * energy: a kick drum produces a flux spike at the same frame the
   * envelope rises, but the energy detector only fires after the envelope
   * sustains for several frames.
   */
  private updateFlux(): number {
    if (!this.freq) return 0;
    if (!this.prevSpectrum || this.prevSpectrum.length !== this.freq.length) {
      this.prevSpectrum = new Uint8Array(this.freq.length);
      this.prevSpectrum.set(this.freq);
      return 0;
    }
    let flux = 0;
    for (let i = 1; i < this.freq.length; i++) {
      const delta = this.freq[i] - this.prevSpectrum[i];
      if (delta > 0) flux += delta;
    }
    this.prevSpectrum.set(this.freq);
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 43) this.fluxHistory.shift();
    return flux;
  }

  /**
   * Spectral-flux beat detector with adaptive threshold. Fires on percussive
   * onsets — kicks, snares, plucks. Refractory 130ms.
   */
  checkBeat(): boolean {
    if (!this.freq) return false;
    const flux = this.updateFlux();
    if (this.fluxHistory.length < 12) return false;
    let avg = 0;
    let max = 0;
    for (const v of this.fluxHistory) {
      avg += v;
      if (v > max) max = v;
    }
    avg /= this.fluxHistory.length;
    const now = performance.now();
    // Beat: flux > avg * 1.55 AND > 30% of recent peak. The peak factor
    // suppresses spurious fires during quiet sections where avg drops low.
    if (
      flux > avg * 1.55 &&
      flux > max * 0.3 &&
      flux > 30 &&
      now - this.lastFluxBeatAt > 130
    ) {
      this.lastFluxBeatAt = now;
      return true;
    }
    return false;
  }

  /**
   * Looser flux-based onset detector. Same flux signal but a lower threshold
   * and shorter refractory — catches hi-hats, vocal consonants, plucks
   * between detected beats.
   */
  checkOnset(): boolean {
    if (!this.freq) return false;
    if (this.fluxHistory.length < 8) return false;
    const flux = this.fluxHistory[this.fluxHistory.length - 1];
    let avg = 0;
    for (const v of this.fluxHistory) avg += v;
    avg /= this.fluxHistory.length;
    const now = performance.now();
    if (flux > avg * 1.22 && flux > 18 && now - this.lastFluxOnsetAt > 70) {
      this.lastFluxOnsetAt = now;
      return true;
    }
    return false;
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
