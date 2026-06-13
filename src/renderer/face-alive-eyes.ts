/**
 * AliveEyeRig — procedural canvas eyes for the alive-face easter egg.
 *
 * Each eye is a small <canvas> positioned over the head bitmap. Why canvas
 * instead of layered bitmaps (the previous three attempts):
 *
 *  - The base layer of every frame is head.png's OWN pixels for that region,
 *    drawn 1:1. The canvas edge is therefore literally invisible — there is
 *    no seam to hide, no clip-path edge, no feathering hack. We do NOT
 *    synthesize or "heal" skin: the head's painted brow, socket shadow, and
 *    cheek are kept exactly, so the eyeball sits in real anatomy.
 *  - The eyeball (sclera/iris/pupil/catchlight) is drawn procedurally inside
 *    an almond aperture that is TALLER than the painted closed-eye slit, so
 *    when open the eyeball fully covers the painted slit; when closed the
 *    aperture shrinks to nothing and the frame is pixel-identical to the
 *    sleeping head art. No cross-fade, no ghosting.
 *  - The upper lid rides the gaze (looking down lowers the lid), and the lid
 *    edge is drawn as the moving aperture boundary — not a sliding bitmap.
 *  - The catchlight moves at ~12% of the gaze vector — a fixed light source.
 *    A photographic eye slides its highlight with the iris, which is the
 *    single biggest "this is a sticker" tell.
 *  - The pupil dilates (wake constriction, beat hits, proximity) — something
 *    a photo iris can never do.
 *
 * All colors are authored in the head's native lime palette; the canvas
 * element carries `filter: var(--theme-filter)` in CSS so themes recolor the
 * eyes exactly like the head bitmap they sit on.
 */

// Geometry, in head-bitmap pixels (head.png is 234×394, displayed 1:1).
const CANVAS_W = 86;
const CANVAS_H = 56;
export const EYE_BOXES = {
  left: { x: 21, y: 246 },
  right: { x: 127, y: 246 },
} as const;

// Aperture: an almond between two quadratic curves, centered on the painted
// eye. Corner slant follows the art (outer corners sit lower).
const APERTURE_CX = 43;
const APERTURE_CY = 29;
const APERTURE_RX = 25;
const TOP_APEX_OPEN = 12.5; // px above center at full open
const BOT_APEX_OPEN = 8.0; // px below center at full open
const CORNER_Y = 1.2; // corners sit slightly below the midline
const CLOSED_LINE_Y = 4.0; // lid meeting line at closure ≈ painted crease
const TILT_DEG = { left: -3.5, right: 3.5 } as const;

// Lid–gaze coupling: the upper lid rides the eyeball. Looking down drops the
// lid; looking up retracts it. This is the strongest "alive" cue in the rig.
const TOP_LID_GAZE_FOLLOW = 0.42;
const BOT_LID_GAZE_FOLLOW = 0.14;

// Eyeball parts.
const IRIS_R = 9.6;
const PUPIL_R = 4.0;
const CATCHLIGHT_PARALLAX = 0.12;

export interface EyeDrawState {
  /** Gaze offset in px from the eye's rest center. +x = viewer right. */
  pupilX: number;
  pupilY: number;
  /** Blink openness 0..1 (1 = fully open). */
  openness: number;
  /** Extra aperture opening for surprise/drop reactions, 0..~0.35. */
  widen: number;
  /** Pupil dilation multiplier (~0.7 constricted .. ~1.35 dilated). */
  pupilScale: number;
  /** Audio glow level (~0.95 quiet .. ~1.45 loud). */
  glow: number;
}

interface EyeAssets {
  closed: HTMLCanvasElement; // raw head.png region — the only base we need
}

export class AliveEyeRig {
  private leftCanvas: HTMLCanvasElement;
  private rightCanvas: HTMLCanvasElement;
  private leftCtx: CanvasRenderingContext2D;
  private rightCtx: CanvasRenderingContext2D;
  private leftAssets: EyeAssets | null = null;
  private rightAssets: EyeAssets | null = null;
  private dpr: number;

  constructor(leftCanvas: HTMLCanvasElement, rightCanvas: HTMLCanvasElement) {
    this.leftCanvas = leftCanvas;
    this.rightCanvas = rightCanvas;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [leftCanvas, rightCanvas]) {
      c.width = CANVAS_W * this.dpr;
      c.height = CANVAS_H * this.dpr;
    }
    this.leftCtx = leftCanvas.getContext("2d")!;
    this.rightCtx = rightCanvas.getContext("2d")!;
    this.leftCtx.scale(this.dpr, this.dpr);
    this.rightCtx.scale(this.dpr, this.dpr);
  }

  async load(headSrc = "head.png"): Promise<void> {
    const img = new Image();
    img.src = headSrc;
    await img.decode();
    this.leftAssets = buildEyeAssets(img, EYE_BOXES.left.x, EYE_BOXES.left.y);
    this.rightAssets = buildEyeAssets(img, EYE_BOXES.right.x, EYE_BOXES.right.y);
    this.drawClosed();
  }

  isReady(): boolean {
    return this.leftAssets !== null;
  }

  /** Restore the painted sleeping face (used on deactivate and after load). */
  drawClosed(): void {
    if (this.leftAssets) {
      this.leftCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      this.leftCtx.drawImage(this.leftAssets.closed, 0, 0, CANVAS_W, CANVAS_H);
    }
    if (this.rightAssets) {
      this.rightCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      this.rightCtx.drawImage(this.rightAssets.closed, 0, 0, CANVAS_W, CANVAS_H);
    }
  }

  draw(left: EyeDrawState, right: EyeDrawState): void {
    if (this.leftAssets) this.drawEye(this.leftCtx, this.leftAssets, left, TILT_DEG.left);
    if (this.rightAssets) this.drawEye(this.rightCtx, this.rightAssets, right, TILT_DEG.right);
  }

  private drawEye(
    g: CanvasRenderingContext2D,
    assets: EyeAssets,
    s: EyeDrawState,
    tiltDeg: number,
  ): void {
    const open = clamp01(s.openness);
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // Base: the head's own painted pixels, untouched. The painted closed-eye
    // slit is covered by the eyeball when open and revealed when closed.
    g.drawImage(assets.closed, 0, 0, CANVAS_W, CANVAS_H);

    // Aperture curves. Top lid follows blink + gaze + widen; bottom lid moves
    // at a fraction of the travel (real lower lids barely move).
    const gazeDrop = s.pupilY * TOP_LID_GAZE_FOLLOW * open;
    const widenLift = s.widen * 6;
    const topApexY =
      lerp(CLOSED_LINE_Y, -TOP_APEX_OPEN, easeOutCubic(open)) + gazeDrop - widenLift;
    const botOpen = 0.3 + 0.7 * open;
    const botApexY =
      lerp(CLOSED_LINE_Y + 0.8, BOT_APEX_OPEN, botOpen) +
      s.pupilY * BOT_LID_GAZE_FOLLOW * open +
      s.widen * 1.6;

    if (topApexY >= botApexY - 0.4) return; // lids met — painted face only

    const tilt = (tiltDeg * Math.PI) / 180;
    const pt = (x: number, y: number): [number, number] => [
      APERTURE_CX + x * Math.cos(tilt) - y * Math.sin(tilt),
      APERTURE_CY + x * Math.sin(tilt) + y * Math.cos(tilt),
    ];
    const [ax, ay] = pt(-APERTURE_RX, CORNER_Y);
    const [bx, by] = pt(APERTURE_RX, CORNER_Y);
    // Quadratic apex sits at half the control offset: control = 2*apex - corner.
    const [tcx, tcy] = pt(0, topApexY * 2 - CORNER_Y);
    const [bcx, bcy] = pt(0, botApexY * 2 - CORNER_Y);
    const aperture = new Path2D();
    aperture.moveTo(ax, ay);
    aperture.quadraticCurveTo(tcx, tcy, bx, by);
    aperture.quadraticCurveTo(bcx, bcy, ax, ay);
    aperture.closePath();

    g.save();
    g.clip(aperture);
    this.drawEyeball(g, s, topApexY);
    g.restore();

    // Lid edges over the aperture boundary. The lash line IS the moving lid.
    const edgeAlpha = clamp01(open / 0.12);
    if (edgeAlpha > 0.01) {
      g.save();
      g.globalAlpha = edgeAlpha;
      // Upper lash: heavy and dark, blending into the painted crease.
      g.strokeStyle = "rgba(8, 14, 2, 0.9)";
      g.lineWidth = 2.2;
      g.lineCap = "round";
      const upper = new Path2D();
      upper.moveTo(ax, ay);
      upper.quadraticCurveTo(tcx, tcy, bx, by);
      g.stroke(upper);
      // Lower lid: thin and subtle.
      g.strokeStyle = "rgba(12, 22, 4, 0.4)";
      g.lineWidth = 1.0;
      const lower = new Path2D();
      lower.moveTo(ax, ay);
      lower.quadraticCurveTo(bcx, bcy, bx, by);
      g.stroke(lower);
      g.restore();
    }
  }

  private drawEyeball(g: CanvasRenderingContext2D, s: EyeDrawState, topApexY: number): void {
    const cx = APERTURE_CX;
    const cy = APERTURE_CY;

    // Sclera: dark olive — these are dim alien eyes, not bright human whites.
    // A soft vertical gradient (lighter low, shadowed under the upper lid).
    const sclera = g.createLinearGradient(0, cy - TOP_APEX_OPEN, 0, cy + BOT_APEX_OPEN);
    sclera.addColorStop(0, "hsl(84, 30%, 34%)");
    sclera.addColorStop(0.55, "hsl(82, 32%, 50%)");
    sclera.addColorStop(1, "hsl(80, 30%, 40%)");
    g.fillStyle = sclera;
    g.fillRect(cx - APERTURE_RX - 2, cy - TOP_APEX_OPEN - 8, APERTURE_RX * 2 + 4, 44);

    // Corner ambient occlusion: the eyeball recedes into the socket.
    for (const side of [-1, 1]) {
      const ao = g.createRadialGradient(
        cx + side * APERTURE_RX,
        cy + CORNER_Y,
        1,
        cx + side * APERTURE_RX,
        cy + CORNER_Y,
        16,
      );
      ao.addColorStop(0, "rgba(10, 18, 3, 0.7)");
      ao.addColorStop(1, "rgba(10, 18, 3, 0)");
      g.fillStyle = ao;
      g.fillRect(cx - APERTURE_RX - 2, cy - 22, APERTURE_RX * 2 + 4, 46);
    }

    // Iris + pupil. Slight elliptical foreshortening as the iris approaches
    // the socket edge fakes a sphere rotating instead of a disc sliding.
    const ix = cx + s.pupilX;
    const iy = cy + s.pupilY;
    const squashX = 1 - 0.22 * Math.min(1, Math.abs(s.pupilX) / 20.5);
    const squashY = 1 - 0.14 * Math.min(1, Math.abs(s.pupilY) / 14);

    g.save();
    g.translate(ix, iy);
    g.scale(squashX, squashY);

    // Iris: luminous amber-green, darkening to a limbal ring.
    const iris = g.createRadialGradient(-2, -2.2, 1, 0, 0, IRIS_R);
    iris.addColorStop(0, "hsl(68, 64%, 52%)");
    iris.addColorStop(0.5, "hsl(78, 66%, 38%)");
    iris.addColorStop(0.82, "hsl(90, 64%, 24%)");
    iris.addColorStop(1, "hsl(100, 55%, 11%)"); // limbal ring
    g.fillStyle = iris;
    g.beginPath();
    g.arc(0, 0, IRIS_R, 0, Math.PI * 2);
    g.fill();

    // Faint radial striations so the iris reads as fibrous, not flat.
    g.strokeStyle = "rgba(230, 248, 180, 0.12)";
    g.lineWidth = 0.6;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.35;
      g.beginPath();
      g.moveTo(Math.cos(a) * IRIS_R * 0.42, Math.sin(a) * IRIS_R * 0.42);
      g.lineTo(Math.cos(a) * IRIS_R * 0.9, Math.sin(a) * IRIS_R * 0.9);
      g.stroke();
    }

    // Pupil with a soft edge.
    const pr = PUPIL_R * s.pupilScale;
    const pupil = g.createRadialGradient(0, 0, pr * 0.7, 0, 0, pr * 1.12);
    pupil.addColorStop(0, "rgba(3, 6, 1, 1)");
    pupil.addColorStop(1, "rgba(3, 6, 1, 0)");
    g.fillStyle = pupil;
    g.beginPath();
    g.arc(0, 0, pr * 1.12, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // Catchlights, in eye space — they track the LIGHT, not the gaze.
    const clx = cx - 3.1 + s.pupilX * CATCHLIGHT_PARALLAX;
    const cly = cy - 3.0 + s.pupilY * CATCHLIGHT_PARALLAX;
    g.fillStyle = "rgba(245, 252, 235, 0.95)";
    g.beginPath();
    g.arc(clx, cly, 1.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(245, 252, 235, 0.3)";
    g.beginPath();
    g.arc(cx + 2.4 + s.pupilX * CATCHLIGHT_PARALLAX, cy + 2.8 + s.pupilY * CATCHLIGHT_PARALLAX, 0.85, 0, Math.PI * 2);
    g.fill();

    // Upper-lid shadow cast onto the eyeball — sells that the ball sits
    // recessed under the lid. Anchored to the moving top curve.
    const shadowTop = cy + topApexY - 1;
    const lidShadow = g.createLinearGradient(0, shadowTop, 0, shadowTop + 8);
    lidShadow.addColorStop(0, "rgba(6, 12, 2, 0.62)");
    lidShadow.addColorStop(1, "rgba(6, 12, 2, 0)");
    g.fillStyle = lidShadow;
    g.fillRect(cx - APERTURE_RX - 2, shadowTop, APERTURE_RX * 2 + 4, 9);

    // Audio glow: additive lime wash around the iris when the music is loud.
    const glowAmt = Math.max(0, s.glow - 1);
    if (glowAmt > 0.01) {
      g.save();
      g.globalCompositeOperation = "lighter";
      const glow = g.createRadialGradient(ix, iy, 2, ix, iy, 16);
      glow.addColorStop(0, `rgba(190, 255, 90, ${0.18 * glowAmt})`);
      glow.addColorStop(1, "rgba(190, 255, 90, 0)");
      g.fillStyle = glow;
      g.fillRect(cx - APERTURE_RX, cy - 18, APERTURE_RX * 2, 38);
      g.restore();
    }
  }
}

/** Cut the eye region out of head.png. No synthesis — the painted face is
 *  the base, and the eyeball overdraws the closed slit when the lids open. */
function buildEyeAssets(headImg: HTMLImageElement, sx: number, sy: number): EyeAssets {
  const closed = document.createElement("canvas");
  closed.width = CANVAS_W;
  closed.height = CANVAS_H;
  const cg = closed.getContext("2d")!;
  cg.drawImage(headImg, sx, sy, CANVAS_W, CANVAS_H, 0, 0, CANVAS_W, CANVAS_H);
  return { closed };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}
