/**
 * AliveEyeRig — procedural canvas eyes for the alive-face easter egg.
 *
 * Each eye is a small <canvas> sitting (z-index 7) directly over the head
 * bitmap (z-index 5). The canvas is TRANSPARENT everywhere except the eyeball
 * itself — we never redraw the head's pixels. This is the whole trick:
 *
 *  - The real #head bitmap supplies the brow, socket, cheek, and the painted
 *    closed-eye slit. The canvas only paints the open eyeball inside an almond
 *    aperture. So there is no rectangle of copied head pixels to mismatch the
 *    real head — no seam, at any devicePixelRatio. (An earlier version drew a
 *    copy of head.png as the base; at fractional DPR the copy resampled
 *    differently than the head underneath and showed as a faint rectangle.)
 *  - The aperture is sized to fully cover the painted closed-eye slit, so when
 *    the eye is open the slit is hidden under the eyeball; when closed the
 *    aperture shrinks to nothing and the canvas is fully transparent, so the
 *    real head's painted sleeping eyes show through, pixel-perfect.
 *  - Catchlight tracks the light source (~12% gaze parallax, not glued to the
 *    iris). Pupil dilates. Upper lid rides the gaze. Iris foreshortens near
 *    the socket edge to fake a rotating sphere.
 *
 * Colors are authored in the head's native lime palette; the canvas carries
 * `filter: var(--theme-filter)` so themes recolor the eyes with the head.
 */

// Canvas display size, in head-bitmap pixels (head.png is 234×394, shown 1:1).
const CANVAS_W = 86;
const CANVAS_H = 56;
// Canvas top-left within #head-group (mirrors the CSS left/top of each eye).
export const EYE_BOXES = {
  left: { x: 21, y: 246 },
  right: { x: 127, y: 246 },
} as const;

// Aperture: an almond between two quadratic curves, centered on the painted
// eye and sized to cover the painted slit.
const APERTURE_CX = 43;
const APERTURE_CY = 29;
const APERTURE_RX = 26;
// The opening is intentionally SHORTER than the iris diameter so the lids
// crop the iris top and bottom — you see a horizontal almond slice of iris
// with sclera only at the sides, never a full floating disc ("doll eye").
const TOP_APEX_OPEN = 8.0; // px above center at full open (lid covers iris top)
const BOT_APEX_OPEN = 9.5; // px below center at full open (iris meets lower lid)
const CORNER_Y = 0.6; // corners sit a touch below the midline
const CLOSED_LINE_Y = 4.0; // lid meeting line at closure ≈ painted crease
// Moderate UPWARD outer-corner (canthal) tilt. The painted brow/socket
// shadow sweeps up harder than this, but the eyelid LINE tilts less than the
// shadow above it — matching the full brow angle reads as a caricatured
// slant. ~4.5deg gives an alert, set-in look without the exaggeration.
const TILT_DEG = { left: 4.5, right: -4.5 } as const;

// Lid–gaze coupling: the upper lid rides the eyeball. Looking down drops the
// lid; looking up retracts it. The strongest "alive" cue in the rig.
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

export class AliveEyeRig {
  private leftCtx: CanvasRenderingContext2D;
  private rightCtx: CanvasRenderingContext2D;
  private ready = false;
  private dpr: number;

  constructor(leftCanvas: HTMLCanvasElement, rightCanvas: HTMLCanvasElement) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [leftCanvas, rightCanvas]) {
      c.width = Math.round(CANVAS_W * this.dpr);
      c.height = Math.round(CANVAS_H * this.dpr);
    }
    this.leftCtx = leftCanvas.getContext("2d")!;
    this.rightCtx = rightCanvas.getContext("2d")!;
    this.leftCtx.scale(this.dpr, this.dpr);
    this.rightCtx.scale(this.dpr, this.dpr);
    this.ready = true;
  }

  // load() kept for API compatibility — the rig is fully procedural now and
  // needs no bitmap, so this just resolves.
  async load(): Promise<void> {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Clear both canvases to transparent — the real head's painted eyes show. */
  drawClosed(): void {
    this.leftCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    this.rightCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  }

  draw(left: EyeDrawState, right: EyeDrawState): void {
    this.drawEye(this.leftCtx, left, TILT_DEG.left);
    this.drawEye(this.rightCtx, right, TILT_DEG.right);
  }

  private drawEye(g: CanvasRenderingContext2D, s: EyeDrawState, tiltDeg: number): void {
    const open = clamp01(s.openness);
    g.clearRect(0, 0, CANVAS_W, CANVAS_H);

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

    if (topApexY >= botApexY - 0.4) return; // lids met — transparent, real face

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

    // Lid edges over the aperture boundary. The lash line IS the moving lid,
    // and these strokes feather the hard clip edge into the painted face.
    const edgeAlpha = clamp01(open / 0.12);
    if (edgeAlpha > 0.01) {
      g.save();
      g.globalAlpha = edgeAlpha;
      // Upper lash: heavy and dark, blending into the painted crease.
      g.strokeStyle = "rgba(8, 14, 2, 0.92)";
      g.lineWidth = 2.4;
      g.lineCap = "round";
      const upper = new Path2D();
      upper.moveTo(ax, ay);
      upper.quadraticCurveTo(tcx, tcy, bx, by);
      g.stroke(upper);
      // Lower lid: thin and subtle.
      g.strokeStyle = "rgba(12, 22, 4, 0.45)";
      g.lineWidth = 1.1;
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

    // Sclera: dark olive — dim alien eyes, not bright human whites. Soft
    // vertical gradient (shadowed under the upper lid, lighter low).
    const sclera = g.createLinearGradient(0, cy - TOP_APEX_OPEN, 0, cy + BOT_APEX_OPEN);
    sclera.addColorStop(0, "hsl(84, 30%, 32%)");
    sclera.addColorStop(0.55, "hsl(82, 32%, 48%)");
    sclera.addColorStop(1, "hsl(80, 30%, 38%)");
    g.fillStyle = sclera;
    g.fillRect(cx - APERTURE_RX - 2, cy - TOP_APEX_OPEN - 8, APERTURE_RX * 2 + 4, 44);

    // Rim shadow just inside the whole aperture so the eyeball seats into the
    // lid instead of ending at a hard cut — softens the clip edge into skin.
    const rim = g.createRadialGradient(cx, cy, IRIS_R + 1, cx, cy, APERTURE_RX + 2);
    rim.addColorStop(0, "rgba(12, 20, 4, 0)");
    rim.addColorStop(0.78, "rgba(12, 20, 4, 0)");
    rim.addColorStop(1, "rgba(12, 20, 4, 0.55)");
    g.fillStyle = rim;
    g.fillRect(cx - APERTURE_RX - 2, cy - TOP_APEX_OPEN - 8, APERTURE_RX * 2 + 4, 44);

    // Iris + pupil. Slight elliptical foreshortening near the socket edge
    // fakes a sphere rotating instead of a disc sliding.
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

    // Upper-lid shadow cast onto the eyeball — the ball sits recessed under
    // the lid. Anchored to the moving top curve.
    const shadowTop = cy + topApexY - 1;
    const lidShadow = g.createLinearGradient(0, shadowTop, 0, shadowTop + 8);
    lidShadow.addColorStop(0, "rgba(6, 12, 2, 0.66)");
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
