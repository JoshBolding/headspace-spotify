/**
 * Custom slider widget styled to match the Headspace skin's dark-green palette.
 *
 * Built as plain divs so we can render either orientation, keep pointer-event
 * behavior identical across both, and avoid styling quirks of <input type=range>.
 *
 * For EQ bands, vertical sliders are used; for balance and volume, horizontal.
 */

export interface SliderOptions {
  orientation: "vertical" | "horizontal";
  min: number;
  max: number;
  value: number;
  width: number; // px
  height: number; // px
  /** Optional center-detent value the thumb snaps lightly to. */
  detent?: number;
  onChange: (value: number) => void;
}

export class SkinSlider {
  readonly el: HTMLDivElement;
  private opts: SliderOptions;
  private value: number;
  private thumb: HTMLDivElement;
  private filled: HTMLDivElement;
  private dragging = false;
  private enabled = true;

  constructor(opts: SliderOptions) {
    this.opts = opts;
    this.value = clamp(opts.value, opts.min, opts.max);

    this.el = document.createElement("div");
    this.el.className = `skin-slider ${opts.orientation}`;
    this.el.style.width = `${opts.width}px`;
    this.el.style.height = `${opts.height}px`;

    this.filled = document.createElement("div");
    this.filled.className = "skin-slider-fill";
    this.el.appendChild(this.filled);

    this.thumb = document.createElement("div");
    this.thumb.className = "skin-slider-thumb";
    this.el.appendChild(this.thumb);

    this.el.addEventListener("pointerdown", (e) => this.onDown(e));
    this.el.addEventListener("pointermove", (e) => this.onMove(e));
    this.el.addEventListener("pointerup", (e) => this.onUp(e));
    this.el.addEventListener("pointercancel", (e) => this.onUp(e));
    this.el.addEventListener("dblclick", () => {
      // double-click = reset to detent (or zero if no detent given)
      this.setValue(opts.detent ?? 0);
      this.opts.onChange(this.value);
    });

    this.layout();
  }

  setValue(v: number) {
    this.value = clamp(v, this.opts.min, this.opts.max);
    this.layout();
  }

  getValue() {
    return this.value;
  }

  isDragging() {
    return this.dragging;
  }

  /** Disabling visually fades the slider and ignores pointer events. */
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.el.classList.toggle("skin-slider-disabled", !enabled);
  }

  private layout() {
    const { min, max, orientation, width, height } = this.opts;
    const t = (this.value - min) / (max - min);

    if (orientation === "vertical") {
      // Vertical: max is at the top, min at the bottom.
      const trackPx = height;
      const yFromTop = (1 - t) * trackPx;
      this.thumb.style.top = `${yFromTop - 4}px`;
      this.thumb.style.left = `${Math.floor(width / 2) - 5}px`;
      // Fill from center detent (0) to current value.
      const detentT = ((this.opts.detent ?? 0) - min) / (max - min);
      const detentY = (1 - detentT) * trackPx;
      const top = Math.min(detentY, yFromTop);
      const h = Math.abs(yFromTop - detentY);
      this.filled.style.top = `${top}px`;
      this.filled.style.height = `${h}px`;
      this.filled.style.left = `${Math.floor(width / 2) - 1}px`;
      this.filled.style.width = `2px`;
    } else {
      const trackPx = width;
      const xFromLeft = t * trackPx;
      this.thumb.style.left = `${xFromLeft - 4}px`;
      this.thumb.style.top = `${Math.floor(height / 2) - 4}px`;
      const detentT = ((this.opts.detent ?? 0) - min) / (max - min);
      const detentX = detentT * trackPx;
      const left = Math.min(detentX, xFromLeft);
      const w = Math.abs(xFromLeft - detentX);
      this.filled.style.left = `${left}px`;
      this.filled.style.width = `${w}px`;
      this.filled.style.top = `${Math.floor(height / 2) - 1}px`;
      this.filled.style.height = `2px`;
    }
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (!this.enabled) return;
    this.dragging = true;
    this.el.setPointerCapture(e.pointerId);
    this.updateFromPointer(e);
  }

  private onMove(e: PointerEvent) {
    if (!this.dragging) return;
    this.updateFromPointer(e);
  }

  private onUp(e: PointerEvent) {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
  }

  private updateFromPointer(e: PointerEvent) {
    const rect = this.el.getBoundingClientRect();
    const { min, max, orientation } = this.opts;
    let t: number;
    if (orientation === "vertical") {
      t = 1 - (e.clientY - rect.top) / rect.height;
    } else {
      t = (e.clientX - rect.left) / rect.width;
    }
    t = clamp(t, 0, 1);
    let v = min + t * (max - min);
    // Light snap to detent within ~6% of range.
    if (this.opts.detent !== undefined) {
      const range = max - min;
      if (Math.abs(v - this.opts.detent) < range * 0.06) v = this.opts.detent;
    }
    this.value = v;
    this.layout();
    this.opts.onChange(this.value);
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
