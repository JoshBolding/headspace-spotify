/**
 * Right-click menu on the face screen: cycle visualizer modes and, when
 * Milkdrop is up, lock / cycle / hop presets.
 */

import { Visualizer, type VisMode } from "./visualizer";
import type { MilkdropDriver } from "./milkdrop-driver";
import { MILKDROP_CYCLE_OPTIONS } from "./milkdrop-driver";
import { flashVisLabel } from "./vis-label";
import { getVizAudioMode, setVizAudioMode, vizAudioLabel } from "./viz-audio-pref";

export function wireVisMenu(
  viz: Visualizer,
  milkdrop: MilkdropDriver,
  onAudioModeChange?: () => void,
): void {
  const visHit = document.getElementById("vis-hit")!;
  const visMenu = document.getElementById("vis-context-menu")!;
  let visMenuOpen = false;

  function hideVisMenu() {
    visMenuOpen = false;
    visMenu.classList.remove("show");
  }

  function switchVisMode(mode: VisMode) {
    viz.setMode(mode);
    flashVisLabel(Visualizer.labelFor(mode));
    void milkdrop.applyVisModeUI(mode);
  }

  function cycleLabel(ms: number): string {
    return ms === 0 ? "Off" : `${Math.round(ms / 1000)}s`;
  }

  function renderVisMenu(x: number, y: number) {
    const mode = viz.getMode();
    visMenu.innerHTML = "";
    const addHead = (t: string) => {
      const d = document.createElement("div");
      d.className = "vm-head";
      d.textContent = t;
      visMenu.appendChild(d);
    };
    const addSep = () => {
      const d = document.createElement("div");
      d.className = "vm-sep";
      visMenu.appendChild(d);
    };
    const addItem = (
      label: string,
      opts: { val?: string; on?: boolean; keepOpen?: boolean; action: () => void } = {
        action: () => {},
      },
    ) => {
      const d = document.createElement("div");
      d.className = "vm-item" + (opts.on ? " vm-on" : "");
      const l = document.createElement("span");
      l.textContent = label;
      d.appendChild(l);
      if (opts.val !== undefined) {
        const v = document.createElement("span");
        v.className = "vm-val";
        v.textContent = opts.val;
        d.appendChild(v);
      }
      d.addEventListener("click", (ev) => {
        ev.stopPropagation();
        opts.action();
        if (opts.keepOpen) renderVisMenu(x, y);
        else hideVisMenu();
      });
      visMenu.appendChild(d);
    };

    addHead(`Visualizer · ${Visualizer.labelFor(mode)}`);
    addItem("Audio", {
      val: vizAudioLabel(),
      keepOpen: true,
      action: () => {
        const next = getVizAudioMode() === "system" ? "spotify" : "system";
        setVizAudioMode(next);
        flashVisLabel(vizAudioLabel(next));
        onAudioModeChange?.();
      },
    });
    if (mode === "milkdrop") {
      if (milkdrop.bcViz.isReady()) {
        addHead(milkdrop.bcViz.currentPresetName());
        addItem("Next preset", {
          keepOpen: true,
          action: () => milkdrop.bcViz.nextPreset(),
        });
        addItem("Previous preset", {
          keepOpen: true,
          action: () => milkdrop.bcViz.prevPreset(),
        });
        addItem("Random preset", {
          keepOpen: true,
          action: () => milkdrop.bcViz.randomPreset(),
        });
        addItem("Lock preset", {
          val: milkdrop.locked ? "ON" : "off",
          on: milkdrop.locked,
          keepOpen: true,
          action: () => milkdrop.setLocked(!milkdrop.locked),
        });
        addItem("Auto-cycle", {
          val: cycleLabel(milkdrop.cycleMs),
          keepOpen: true,
          action: () => {
            const i = MILKDROP_CYCLE_OPTIONS.indexOf(milkdrop.cycleMs);
            milkdrop.setCycle(
              MILKDROP_CYCLE_OPTIONS[(i + 1) % MILKDROP_CYCLE_OPTIONS.length],
            );
          },
        });
      } else {
        addHead("no live audio — play a track");
      }
      addSep();
      addItem("Next visualizer mode", {
        action: () => {
          const m = viz.cycleMode();
          flashVisLabel(Visualizer.labelFor(m));
          void milkdrop.applyVisModeUI(m);
        },
      });
    } else {
      addItem("Switch to Milkdrop", { action: () => switchVisMode("milkdrop") });
      addItem("Next visualizer mode", {
        action: () => {
          const m = viz.cycleMode();
          flashVisLabel(Visualizer.labelFor(m));
          void milkdrop.applyVisModeUI(m);
        },
      });
    }

    visMenu.classList.add("show");
    visMenuOpen = true;
    const w = visMenu.offsetWidth;
    const h = visMenu.offsetHeight;
    visMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    visMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  }

  visHit.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    renderVisMenu(e.clientX, e.clientY);
  });
  document.addEventListener("pointerdown", (e) => {
    if (visMenuOpen && !visMenu.contains(e.target as Node)) hideVisMenu();
  });
}
