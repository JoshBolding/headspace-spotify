/**
 * Butterchurn lifecycle: lazy WebGL init, drop-driven preset switches,
 * auto-cycle timer, and the lock that freezes the current preset.
 */

import type { ButterchurnViz } from "./butterchurn-viz";
import type { LiveAudio } from "./live-audio";
import type { VisMode } from "./visualizer";

export const MILKDROP_CYCLE_OPTIONS = [10_000, 30_000, 60_000, 0]; // 0 = off

export class MilkdropDriver {
  private dropRaf: number | null = null;
  private presetTimer: number | null = null;
  locked = localStorage.getItem("headspace.milkdrop.locked") === "1";
  cycleMs = Number(localStorage.getItem("headspace.milkdrop.cycle") ?? "30000");

  constructor(
    readonly bcViz: ButterchurnViz,
    private readonly liveAudio: LiveAudio,
  ) {
    if (!MILKDROP_CYCLE_OPTIONS.includes(this.cycleMs)) this.cycleMs = 30_000;
  }

  async ensureButterchurn(): Promise<boolean> {
    if (this.bcViz.isReady()) return true;
    if (this.bcViz.hasFailed()) return false;
    const graph = this.liveAudio.getAudioGraph();
    if (!graph) return false;
    return this.bcViz.init(graph.ctx, graph.node);
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    localStorage.setItem("headspace.milkdrop.locked", locked ? "1" : "0");
    this.refreshDrivers();
  }

  setCycle(ms: number): void {
    this.cycleMs = ms;
    localStorage.setItem("headspace.milkdrop.cycle", String(ms));
    this.refreshDrivers();
  }

  async applyVisModeUI(mode: VisMode): Promise<void> {
    const isMilkdrop = mode === "milkdrop";
    document.body.classList.toggle("vis-milkdrop", isMilkdrop);
    if (isMilkdrop) {
      const ok = await this.ensureButterchurn();
      document.body.classList.toggle("milkdrop-idle", !ok);
      if (ok) {
        this.bcViz.resize();
        this.bcViz.start();
        this.startDrivers();
      }
    } else {
      this.bcViz.stop();
      this.stopDrivers();
      document.body.classList.remove("milkdrop-idle");
    }
  }

  private startDrivers(): void {
    this.stopDrivers();
    const poll = () => {
      if (this.bcViz.isReady() && !this.locked && this.liveAudio.checkDrop()) {
        this.bcViz.onDrop();
      }
      this.dropRaf = requestAnimationFrame(poll);
    };
    this.dropRaf = requestAnimationFrame(poll);
    if (!this.locked && this.cycleMs > 0) {
      this.presetTimer = window.setInterval(() => {
        if (this.bcViz.isReady() && !this.locked) this.bcViz.nextPreset();
      }, this.cycleMs);
    }
  }

  private stopDrivers(): void {
    if (this.dropRaf !== null) cancelAnimationFrame(this.dropRaf);
    this.dropRaf = null;
    if (this.presetTimer !== null) window.clearInterval(this.presetTimer);
    this.presetTimer = null;
  }

  private refreshDrivers(): void {
    if (document.body.classList.contains("vis-milkdrop") && this.bcViz.isReady()) {
      this.startDrivers();
    }
  }
}
