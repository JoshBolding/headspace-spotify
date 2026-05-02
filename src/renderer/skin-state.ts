/**
 * Port of headspace.js drawer state machine.
 *
 * Original positions (from native WMS):
 *   plClosedPos = 277, plOpenedPos = 488   (right ear / playlist)
 *   eqClosedPos = 207, eqOpenedPos = 0     (left ear / EQ)
 *   widthClosed = 549, widthOpened = 760
 *
 * Same math, retargeted to CSS transforms + IPC window resize.
 */

const PL_DELTA = 488 - 277; // 211px right slide
const EQ_DELTA = 0 - 207; // -207px left slide

const WIDTH_CLOSED = 549;
const WIDTH_OPENED_PL = 760; // playlist open
const VIEW_H = 394;

const ANIM_MS = 220;

export class SkinState {
  private plOpen = false;
  private eqOpen = false;

  private plEar: HTMLElement;
  private eqEar: HTMLElement;
  private plHandleBtn: HTMLElement;
  private eqHandleBtn: HTMLElement;

  constructor(opts: {
    plEar: HTMLElement;
    eqEar: HTMLElement;
    plHandle: HTMLElement;
    eqHandle: HTMLElement;
  }) {
    this.plEar = opts.plEar;
    this.eqEar = opts.eqEar;
    this.plHandleBtn = opts.plHandle;
    this.eqHandleBtn = opts.eqHandle;

    this.plEar.style.transition = `transform ${ANIM_MS}ms ease`;
    this.eqEar.style.transition = `transform ${ANIM_MS}ms ease`;
  }

  get isPlaylistOpen() {
    return this.plOpen;
  }

  togglePlaylist() {
    if (this.plOpen) {
      // Close: slide ear back first, then shrink window when slide finishes.
      this.plEar.style.transform = `translateX(0)`;
      this.plHandleBtn.classList.remove("open");
      window.setTimeout(() => {
        window.headspace.setSize(WIDTH_CLOSED, VIEW_H);
      }, ANIM_MS);
      this.plOpen = false;
    } else {
      // Open: grow window first so the ear has room to slide into.
      window.headspace.setSize(WIDTH_OPENED_PL, VIEW_H);
      // Force a layout tick so the new width is in place before the slide.
      requestAnimationFrame(() => {
        this.plEar.style.transform = `translateX(${PL_DELTA}px)`;
        this.plHandleBtn.classList.add("open");
      });
      this.plOpen = true;
    }
  }

  // EQ stub for now — slides but does nothing else. Width does not change
  // when EQ opens because EQ slides over the body, not outside the window.
  toggleEq() {
    if (this.eqOpen) {
      this.eqEar.style.transform = `translateX(0)`;
      this.eqHandleBtn.classList.remove("open");
      this.eqOpen = false;
    } else {
      this.eqEar.style.transform = `translateX(${EQ_DELTA}px)`;
      this.eqHandleBtn.classList.add("open");
      this.eqOpen = true;
    }
  }
}
