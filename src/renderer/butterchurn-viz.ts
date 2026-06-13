/**
 * Butterchurn (Milkdrop 2) WebGL visualizer for the face screen.
 *
 * This is the "vis in the brain" mode — a nod to the skin's Winamp lineage.
 * Butterchurn renders Milkdrop presets in WebGL to its own canvas, fed by a
 * live AudioNode. It therefore only works when LiveAudio has a real source
 * (tap or loopback); under the synthetic-analysis fallback there's no audio
 * graph to feed it, so the mode shows an idle hint instead.
 *
 * The library is loaded lazily on first activation so its ~1MB bundle isn't
 * paid for unless the user actually selects the mode.
 */

// Curated preset shortlist — punchy, legible at small size, not too busy.
// Falls back to whatever the pack ships if a name isn't present.
const PREFERRED_PRESETS = [
  "Flexi, martin + geiss - dedicated to the sherwin maxawow",
  "martin - mandelbox explorer - high speed demo",
  "Geiss - Reaction Diffusion 2",
  "flexi - mindblob [shifter]",
  "$$$ Royal - Mashup (Quad Frenzy)",
  "Goody - The Wormhole Pillars (Reprise)",
  "cope - cosmic dust 3",
];

interface ButterchurnVisualizer {
  connectAudio(node: AudioNode): void;
  loadPreset(preset: unknown, blendTime: number): void;
  setRendererSize(w: number, h: number): void;
  render(): void;
}

export class ButterchurnViz {
  private canvas: HTMLCanvasElement;
  private visualizer: ButterchurnVisualizer | null = null;
  private presets: Record<string, unknown> = {};
  private presetKeys: string[] = [];
  private presetIndex = 0;
  private rafHandle: number | null = null;
  private rendering = false;
  private loadFailed = false;
  private dpr: number;
  private lastPresetSwitchAt = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
  }

  isReady(): boolean {
    return this.visualizer !== null;
  }

  hasFailed(): boolean {
    return this.loadFailed;
  }

  /**
   * Lazy-init the WebGL visualizer against a live audio graph. Safe to call
   * repeatedly — re-initializes if the audio source changed (new node).
   */
  async init(ctx: AudioContext, node: AudioNode): Promise<boolean> {
    if (this.loadFailed) return false;
    try {
      const bcMod = (await import("butterchurn")) as unknown as {
        default?: { createVisualizer: (...a: unknown[]) => ButterchurnVisualizer };
        createVisualizer?: (...a: unknown[]) => ButterchurnVisualizer;
      };
      const presetsMod = (await import("butterchurn-presets")) as unknown as {
        default?: { getPresets: () => Record<string, unknown> };
        getPresets?: () => Record<string, unknown>;
      };
      const createVisualizer = bcMod.default?.createVisualizer ?? bcMod.createVisualizer;
      const getPresets = presetsMod.default?.getPresets ?? presetsMod.getPresets;
      if (!createVisualizer || !getPresets) throw new Error("butterchurn API shape unexpected");

      const w = this.canvas.clientWidth || 230;
      const h = this.canvas.clientHeight || 175;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);

      this.visualizer = createVisualizer(ctx, this.canvas, {
        width: this.canvas.width,
        height: this.canvas.height,
        pixelRatio: 1, // we already baked dpr into width/height
        textureRatio: 1,
      });
      this.visualizer.connectAudio(node);
      this.visualizer.setRendererSize(this.canvas.width, this.canvas.height);

      this.presets = getPresets();
      const all = Object.keys(this.presets);
      // Order the preferred ones first (those that exist), then the rest.
      const preferred = PREFERRED_PRESETS.filter((k) => k in this.presets);
      const rest = all.filter((k) => !preferred.includes(k));
      this.presetKeys = [...preferred, ...rest];
      if (this.presetKeys.length === 0) throw new Error("no presets available");
      this.presetIndex = 0;
      this.visualizer.loadPreset(this.presets[this.presetKeys[0]], 0);
      return true;
    } catch (err) {
      console.warn("[butterchurn] init failed:", err);
      this.loadFailed = true;
      this.visualizer = null;
      return false;
    }
  }

  start(): void {
    if (!this.visualizer || this.rendering) return;
    this.rendering = true;
    const loop = () => {
      if (!this.rendering || !this.visualizer) return;
      this.visualizer.render();
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.rendering = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /** Advance to the next preset with a crossfade. */
  nextPreset(blendTime = 2.7): void {
    if (!this.visualizer || this.presetKeys.length === 0) return;
    this.presetIndex = (this.presetIndex + 1) % this.presetKeys.length;
    this.visualizer.loadPreset(this.presets[this.presetKeys[this.presetIndex]], blendTime);
  }

  /**
   * Beat-drop hook: switch to a random preset, but no more than once every
   * few seconds so drops in dense sections don't strobe presets.
   */
  onDrop(): void {
    if (!this.visualizer) return;
    const now = performance.now();
    if (now - this.lastPresetSwitchAt < 6000) return;
    this.lastPresetSwitchAt = now;
    const next = Math.floor(Math.random() * this.presetKeys.length);
    this.presetIndex = next;
    this.visualizer.loadPreset(this.presets[this.presetKeys[next]], 1.5);
  }

  resize(): void {
    if (!this.visualizer) return;
    const w = this.canvas.clientWidth || 230;
    const h = this.canvas.clientHeight || 175;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.visualizer.setRendererSize(this.canvas.width, this.canvas.height);
  }
}
