/**
 * Alpha hit-test + window drag.
 *
 * The window is a shaped transparent surface. Main only receives clicks
 * where the renderer says the pixel is opaque, so we sample the head mask
 * plus a few known chrome hit-targets on every pointer move.
 */

export const HEAD_W = 234;
export const HEAD_H = 394;
export const HEAD_X = 261;
export const VIEW_W_CLOSED = 549;
export const MINI_SCALE = 0.5;
const ALPHA_THRESHOLD = 16;

let headMask: Uint8Array | null = null;

async function buildHeadMask(): Promise<void> {
  const img = new Image();
  img.src = "head.png";
  await img.decode();
  const c = document.createElement("canvas");
  c.width = HEAD_W;
  c.height = HEAD_H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, HEAD_W, HEAD_H);
  const data = ctx.getImageData(0, 0, HEAD_W, HEAD_H).data;
  const mask = new Uint8Array(HEAD_W * HEAD_H);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] >= ALPHA_THRESHOLD ? 1 : 0;
  }
  headMask = mask;
  drawDebugMask(mask);
}

function drawDebugMask(mask: Uint8Array): void {
  const canvas = document.getElementById("debug-mask") as HTMLCanvasElement;
  canvas.width = HEAD_W;
  canvas.height = HEAD_H;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(HEAD_W, HEAD_H);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      imageData.data[i * 4 + 0] = 255;
      imageData.data[i * 4 + 2] = 255;
      imageData.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function isHeadPixel(x: number, y: number): boolean {
  if (!headMask) return false;
  const scale = document.body.classList.contains("mini") ? MINI_SCALE : 1;
  const hx = Math.floor(x / scale - HEAD_X);
  const hy = Math.floor(y / scale);
  if (hx < 0 || hy < 0 || hx >= HEAD_W || hy >= HEAD_H) return false;
  return headMask[hy * HEAD_W + hx] === 1;
}

function isOpaqueAt(x: number, y: number): boolean {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.dataset.opaque === "1") return true;
    if (el.classList.contains("hotzone")) return true;
    if (el.classList.contains("ear-handle")) return true;
    if (el.classList.contains("drawer-body")) return true;
    if (el.closest(".drawer-body")) return true;
    if (el.id === "transport" || el.id === "seek-track") return true;
    if (el.classList.contains("ear-img")) return true;
  }
  return isHeadPixel(x, y);
}

function wireHitTesting(): void {
  let lastState: boolean | null = null;
  document.addEventListener(
    "pointermove",
    (e) => {
      const opaque = isOpaqueAt(e.clientX, e.clientY);
      if (opaque !== lastState) {
        lastState = opaque;
        window.headspace.hitTest(opaque);
      }
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => {
    if (lastState !== false) {
      lastState = false;
      window.headspace.hitTest(false);
    }
  });
}

function wireDrag(): void {
  const drag = document.getElementById("drag");
  if (!drag) return;
  let dragging = false;
  drag.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!isHeadPixel(e.clientX, e.clientY)) return;
    e.preventDefault();
    dragging = true;
    window.headspace.dragStart(e.clientX, e.clientY);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    window.headspace.dragEnd();
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", end);
}

export async function initHitTest(): Promise<void> {
  await buildHeadMask();
  wireHitTesting();
  wireDrag();
}
