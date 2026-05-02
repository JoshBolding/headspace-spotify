/**
 * Transport buttons rendered on a canvas with proper per-pixel state mixing.
 *
 * The original Headspace skin ships four full-bar bitmaps (default / rollover /
 * down / disabled) and a hit-test "map" bitmap whose color regions identify
 * which button each pixel belongs to. We replicate the exact technique:
 *
 *   - Decode all four state bitmaps and the map into ImageData.
 *   - Build a per-pixel "button index" array from the map's color codes.
 *   - On render, for each pixel pick whichever state's bitmap matches that
 *     button's current state (default / hover / down).
 *
 * Result: only the button under the cursor lights up, and only the button
 * being pressed shows the down frame — no manual rectangles, no per-button
 * compositing, no chance of misalignment.
 */

export type TransportButton = "prev" | "play" | "stop" | "next" | "vis";

const W = 144;
const H = 25;

// Map color → button identity. Values match headspace.wms.
const COLOR_TO_BUTTON: Record<string, TransportButton> = {
  "255,0,51": "prev",
  "255,255,0": "play",
  "0,255,0": "stop",
  "0,255,255": "next",
  "0,0,255": "vis",
};

const BUTTONS: readonly TransportButton[] = [
  "prev",
  "play",
  "stop",
  "next",
  "vis",
];

const BTN_TO_INDEX: Record<TransportButton, number> = {
  prev: 1,
  play: 2,
  stop: 3,
  next: 4,
  vis: 5,
};
const INDEX_TO_BTN: (TransportButton | null)[] = [
  null,
  "prev",
  "play",
  "stop",
  "next",
  "vis",
];

interface Frames {
  def: Uint8ClampedArray;
  hover: Uint8ClampedArray;
  down: Uint8ClampedArray;
}

export interface TransportHandlers {
  onClick: (btn: TransportButton) => void;
  onHover?: (btn: TransportButton | null) => void;
}

export class Transport {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frames: Frames;
  private buttonIndex: Uint8Array; // length W*H, 0=none
  private hoverBtn: TransportButton | null = null;
  private downBtn: TransportButton | null = null;
  private handlers: TransportHandlers;

  static async create(
    root: HTMLElement,
    handlers: TransportHandlers,
  ): Promise<Transport> {
    const [defImg, hoverImg, downImg, mapImg] = await Promise.all([
      loadFrame("play_controls_01_default.png"),
      loadFrame("play_controls_02_rollover.png"),
      loadFrame("play_controls_03_down.png"),
      loadFrame("play_controls_map.png"),
    ]);
    const buttonIndex = buildButtonIndex(mapImg);
    return new Transport(
      root,
      { def: defImg, hover: hoverImg, down: downImg },
      buttonIndex,
      handlers,
    );
  }

  private constructor(
    root: HTMLElement,
    frames: Frames,
    buttonIndex: Uint8Array,
    handlers: TransportHandlers,
  ) {
    this.root = root;
    this.frames = frames;
    this.buttonIndex = buttonIndex;
    this.handlers = handlers;

    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.canvas.style.display = "block";
    this.canvas.style.imageRendering = "auto";
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.render();

    this.root.addEventListener("pointermove", (e) => this.onMove(e));
    this.root.addEventListener("pointerleave", () => this.onLeave());
    this.root.addEventListener("pointerdown", (e) => this.onDown(e));
    this.root.addEventListener("pointerup", (e) => this.onUp(e));
    this.root.addEventListener("pointercancel", () => this.onCancel());
  }

  private hitTest(e: PointerEvent | MouseEvent): TransportButton | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * W);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * H);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const idx = this.buttonIndex[y * W + x];
    return INDEX_TO_BTN[idx] ?? null;
  }

  private setHover(btn: TransportButton | null) {
    if (btn === this.hoverBtn) return;
    this.hoverBtn = btn;
    this.render();
    this.handlers.onHover?.(btn);
  }

  private setDown(btn: TransportButton | null) {
    if (btn === this.downBtn) return;
    this.downBtn = btn;
    this.render();
  }

  private onMove(e: PointerEvent) {
    this.setHover(this.hitTest(e));
  }
  private onLeave() {
    this.setHover(null);
    this.setDown(null);
  }
  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const b = this.hitTest(e);
    this.setDown(b);
  }
  private onUp(e: PointerEvent) {
    if (e.button !== 0) return;
    const releaseTarget = this.hitTest(e);
    const downBtn = this.downBtn;
    this.setDown(null);
    if (downBtn && releaseTarget === downBtn) this.handlers.onClick(downBtn);
  }
  private onCancel() {
    this.setDown(null);
  }

  private render() {
    const out = this.ctx.createImageData(W, H);
    const dst = out.data;
    const def = this.frames.def;
    const hover = this.frames.hover;
    const down = this.frames.down;
    const idx = this.buttonIndex;
    const hoverIdx = this.hoverBtn ? BTN_TO_INDEX[this.hoverBtn] : 0;
    const downIdx = this.downBtn ? BTN_TO_INDEX[this.downBtn] : 0;
    const len = W * H;
    for (let i = 0; i < len; i++) {
      const id = idx[i];
      let src: Uint8ClampedArray;
      if (id !== 0 && id === downIdx) src = down;
      else if (id !== 0 && id === hoverIdx) src = hover;
      else src = def;
      const o = i * 4;
      dst[o] = src[o];
      dst[o + 1] = src[o + 1];
      dst[o + 2] = src[o + 2];
      dst[o + 3] = src[o + 3];
    }
    this.ctx.putImageData(out, 0, 0);
  }
}

async function loadFrame(src: string): Promise<Uint8ClampedArray> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, W, H);
  return g.getImageData(0, 0, W, H).data;
}

function buildButtonIndex(mapData: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const key = `${mapData[i]},${mapData[i + 1]},${mapData[i + 2]}`;
      const btn = COLOR_TO_BUTTON[key];
      out[y * W + x] = btn ? BTN_TO_INDEX[btn] : 0;
    }
  }
  return out;
}

// Silence unused — BUTTONS constant kept for documentation/future iteration.
void BUTTONS;
