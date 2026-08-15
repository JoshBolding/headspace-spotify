/**
 * SpeakerRig — physical speaker-cone excursion for the alive-face mode.
 *
 * The ear bitmaps have fully painted speakers (metal basket rim with screws,
 * paper cone, dust cap). The previous attempt pulsed a translucent gradient
 * blob OVER the painting with mix-blend-mode — a light flare on a static
 * speaker, which is why it never read as motion.
 *
 * This rig cuts the actual cone and dust-cap pixels out of right_ear.png at
 * runtime (feathered circular crops) and redraws them scaled on a canvas
 * layered exactly over the painted ear. At rest the sprites align 1:1 with
 * the art underneath — invisible. On excursion, the cap scales more than the
 * cone (differential parallax = the cone pushes out of the basket), the cone
 * darkens slightly (its angle to the light changed), and a soft shadow grows
 * under the rim.
 *
 * Motion is a spring-damper per band: spectral-flux beats inject velocity
 * impulses, band energy sets the sustain target. Mass is what makes it read
 * as a physical object instead of a flickering map of the energy curve.
 */

// Speaker centers in right_ear.png image coordinates (87×170). The same
// bitmap is used for both ears (the left ear mirrors it in CSS).
const SPEAKERS = [
  { band: "high" as const, x: 52, y: 39, coneR: 14.5, capR: 6.0 },
  { band: "mid" as const, x: 35, y: 86, coneR: 15.5, capR: 6.5 },
  { band: "bass" as const, x: 35, y: 134, coneR: 15.5, capR: 6.5 },
];

const EAR_W = 87;
const EAR_H = 170;

// Spring tuning per band. Bass: stiff and punchy with visible ring-back.
const SPRING = {
  bass: { k: 240, c: 7.5, impulse: 9.0, sustain: 0.55 },
  mid: { k: 300, c: 9.0, impulse: 5.0, sustain: 0.5 },
  high: { k: 360, c: 10.5, impulse: 3.6, sustain: 0.45 },
} as const;

export interface BandLevels {
  bass: number;
  mid: number;
  high: number;
}

interface ConeSprites {
  cone: HTMLCanvasElement;
  cap: HTMLCanvasElement;
}

interface SpringState {
  pos: number;
  vel: number;
}

export class SpeakerRig {
  private canvases: HTMLCanvasElement[] = [];
  private contexts: CanvasRenderingContext2D[] = [];
  private sprites: ConeSprites[] | null = null;
  private springs: Record<"bass" | "mid" | "high", SpringState> = {
    bass: { pos: 0, vel: 0 },
    mid: { pos: 0, vel: 0 },
    high: { pos: 0, vel: 0 },
  };
  private dpr: number;

  /**
   * @param hosts The two ear containers. A canvas is created in each,
   *              positioned to exactly cover that ear's .ear-img.
   */
  constructor(hosts: Array<{ container: HTMLElement; mirrored: boolean }>) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const host of hosts) {
      const canvas = document.createElement("canvas");
      canvas.className = "speaker-cone-canvas";
      canvas.width = EAR_W * this.dpr;
      canvas.height = EAR_H * this.dpr;
      canvas.dataset.mirrored = host.mirrored ? "1" : "0";
      host.container.appendChild(canvas);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(this.dpr, this.dpr);
      this.canvases.push(canvas);
      this.contexts.push(ctx);
    }
  }

  async load(earSrc = "right_ear.png"): Promise<void> {
    const img = new Image();
    img.src = earSrc;
    await img.decode();
    this.sprites = SPEAKERS.map((sp) => ({
      cone: cutCircle(img, sp.x, sp.y, sp.coneR, 2.2),
      cap: cutCircle(img, sp.x, sp.y, sp.capR, 1.6),
    }));
  }

  isReady(): boolean {
    return this.sprites !== null;
  }

  /** Apply the same recoil transform the ear image gets, so they move as one. */
  setRecoil(transformByCanvas: string[]): void {
    for (let i = 0; i < this.canvases.length; i++) {
      this.canvases[i].style.transform = transformByCanvas[i] ?? "";
    }
  }

  /**
   * Advance physics and redraw. `beat`/`onset` are one-frame impulse flags;
   * `levels` are smoothed 0..1 band energies (fast attack / slow release).
   */
  update(dtMs: number, levels: BandLevels, beat: boolean, onset: boolean): void {
    const dt = Math.min(0.05, dtMs / 1000);

    this.stepSpring("bass", levels.bass, beat ? 1 : 0, dt);
    this.stepSpring("mid", levels.mid, onset ? 0.8 : 0, dt);
    this.stepSpring("high", levels.high, onset ? 0.7 : 0, dt);

    if (!this.sprites) return;
    for (const ctx of this.contexts) {
      ctx.clearRect(0, 0, EAR_W, EAR_H);
      for (let i = 0; i < SPEAKERS.length; i++) {
        const sp = SPEAKERS[i];
        const e = Math.max(-0.25, this.springs[sp.band].pos);
        this.drawSpeaker(ctx, this.sprites[i], sp, e);
      }
    }
  }

  /** Clear all motion (deactivate). */
  reset(): void {
    for (const band of ["bass", "mid", "high"] as const) {
      this.springs[band].pos = 0;
      this.springs[band].vel = 0;
    }
    for (const ctx of this.contexts) ctx.clearRect(0, 0, EAR_W, EAR_H);
  }

  private stepSpring(
    band: "bass" | "mid" | "high",
    level: number,
    impulseScale: number,
    dt: number,
  ): void {
    const tune = SPRING[band];
    const s = this.springs[band];
    if (impulseScale > 0) {
      s.vel += tune.impulse * impulseScale * (0.45 + level * 0.8);
    }
    const target = level * tune.sustain;
    // Semi-implicit Euler — stable at rAF timesteps for these stiffnesses.
    const accel = -tune.k * (s.pos - target) - tune.c * s.vel;
    s.vel += accel * dt;
    s.pos += s.vel * dt;
  }

  private drawSpeaker(
    g: CanvasRenderingContext2D,
    sprites: ConeSprites,
    sp: (typeof SPEAKERS)[number],
    e: number,
  ): void {
    if (Math.abs(e) < 0.004) return; // at rest the painted art is identical

    // Differential scale: the dust cap travels much more than the cone, so the
    // cap visibly pushes out of the basket (parallax = real depth, not a flat
    // pulse). Tuned to read clearly at a glance without going cartoonish.
    const coneScale = 1 + e * 0.09;
    const capScale = 1 + e * 0.24;

    // Depth shadow inside the basket rim grows with excursion.
    if (e > 0.05) {
      const ring = g.createRadialGradient(sp.x, sp.y, sp.coneR * 0.55, sp.x, sp.y, sp.coneR * 1.06);
      ring.addColorStop(0, "rgba(0, 0, 0, 0)");
      ring.addColorStop(0.8, `rgba(0, 0, 0, ${Math.min(0.4, e * 0.32)})`);
      ring.addColorStop(1, "rgba(0, 0, 0, 0)");
      g.fillStyle = ring;
      g.beginPath();
      g.arc(sp.x, sp.y, sp.coneR * 1.08, 0, Math.PI * 2);
      g.fill();
    }

    // Cone, scaled about its center. Slight darkening at high excursion.
    drawCentered(g, sprites.cone, sp.x, sp.y, coneScale);
    if (e > 0.1) {
      g.save();
      g.globalCompositeOperation = "source-atop";
      g.fillStyle = `rgba(10, 10, 10, ${Math.min(0.18, (e - 0.1) * 0.16)})`;
      g.beginPath();
      g.arc(sp.x, sp.y, sp.coneR * coneScale, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // Dust cap, scaled harder and lifted slightly — the differential is the
    // parallax cue that sells the cone pushing toward the viewer.
    drawCentered(g, sprites.cap, sp.x, sp.y - e * 1.1, capScale);

    // Tiny specular pop on the cap at strong excursion.
    if (e > 0.35) {
      g.save();
      g.globalCompositeOperation = "lighter";
      g.fillStyle = `rgba(255, 255, 255, ${Math.min(0.12, (e - 0.35) * 0.1)})`;
      g.beginPath();
      g.arc(sp.x - 1.5, sp.y - e * 0.6 - 1.5, sp.capR * 0.7, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
}

function drawCentered(
  g: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  cx: number,
  cy: number,
  scale: number,
): void {
  // Sprite canvases are sized 2r+feather*2; their center maps to (cx, cy).
  const w = sprite.width;
  const h = sprite.height;
  g.drawImage(sprite, cx - (w * scale) / 2, cy - (h * scale) / 2, w * scale, h * scale);
}

/** Cut a feathered circular sprite out of the ear bitmap. */
function cutCircle(
  img: HTMLImageElement,
  cx: number,
  cy: number,
  r: number,
  feather: number,
): HTMLCanvasElement {
  const size = Math.ceil((r + feather) * 2);
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.drawImage(img, cx - size / 2, cy - size / 2, size, size, 0, 0, size, size);
  // Feathered alpha mask: opaque to r-feather, fading to 0 at r+feather.
  g.globalCompositeOperation = "destination-in";
  const mask = g.createRadialGradient(
    size / 2,
    size / 2,
    Math.max(0, r - feather),
    size / 2,
    size / 2,
    r + feather,
  );
  mask.addColorStop(0, "rgba(0, 0, 0, 1)");
  mask.addColorStop(1, "rgba(0, 0, 0, 0)");
  g.fillStyle = mask;
  g.fillRect(0, 0, size, size);
  return c;
}
