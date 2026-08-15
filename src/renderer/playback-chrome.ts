/**
 * Shuffle, repeat, and device picker — the transport extras that didn't
 * fit on the original 2001 bitmap bar.
 */

import { isErrorResult } from "../shared/spotify-types";
import type { PlaybackDevice } from "../shared/spotify-types";
import type { SpotifyController, SpotifyState } from "./spotify-player";
import type { StatusOverlay } from "./status-overlay";

export function wirePlaybackChrome(
  controller: SpotifyController,
  status: StatusOverlay,
): void {
  const shuffleBtn = document.getElementById("btn-shuffle") as HTMLButtonElement | null;
  const repeatBtn = document.getElementById("btn-repeat") as HTMLButtonElement | null;
  const deviceBtn = document.getElementById("btn-devices") as HTMLButtonElement | null;
  const deviceMenu = document.getElementById("device-menu");

  const paint = (s: SpotifyState) => {
    if (shuffleBtn) {
      shuffleBtn.classList.toggle("active", s.shuffle);
      shuffleBtn.title = s.shuffle ? "Shuffle on" : "Shuffle off";
    }
    if (repeatBtn) {
      repeatBtn.classList.toggle("active", s.repeat !== "off");
      repeatBtn.dataset.mode = s.repeat;
      repeatBtn.title =
        s.repeat === "track"
          ? "Repeat track"
          : s.repeat === "context"
            ? "Repeat context"
            : "Repeat off";
      repeatBtn.textContent = s.repeat === "track" ? "1" : "⟳";
    }
  };

  controller.on(paint);
  paint(controller.state());

  shuffleBtn?.addEventListener("click", async () => {
    const r = await controller.setShuffle(!controller.state().shuffle);
    if (!r.ok) status.showPlaybackError(r.error);
  });

  repeatBtn?.addEventListener("click", async () => {
    const r = await controller.cycleRepeat();
    if (!r.ok) status.showPlaybackError(r.error);
  });

  if (deviceBtn && deviceMenu) {
    let open = false;
    const hide = () => {
      open = false;
      deviceMenu.classList.remove("show");
    };
    deviceBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (open) {
        hide();
        return;
      }
      deviceMenu.innerHTML = "";
      const head = document.createElement("div");
      head.className = "vm-head";
      head.textContent = "Devices";
      deviceMenu.appendChild(head);
      const res = await window.headspace.spDevices();
      if (isErrorResult(res)) {
        const empty = document.createElement("div");
        empty.className = "vm-head";
        empty.textContent = res.error;
        deviceMenu.appendChild(empty);
      } else if (!res.length) {
        const empty = document.createElement("div");
        empty.className = "vm-head";
        empty.textContent = "No devices found";
        deviceMenu.appendChild(empty);
      } else {
        for (const d of res) addDeviceRow(deviceMenu, d, controller, status, hide);
      }
      deviceMenu.classList.add("show");
      open = true;
      const r = deviceBtn.getBoundingClientRect();
      const w = deviceMenu.offsetWidth;
      const h = deviceMenu.offsetHeight;
      deviceMenu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
      deviceMenu.style.top = `${Math.max(4, Math.min(r.bottom + 4, window.innerHeight - h - 4))}px`;
    });
    document.addEventListener("pointerdown", (e) => {
      if (open && !deviceMenu.contains(e.target as Node) && e.target !== deviceBtn) {
        hide();
      }
    });
  }
}

function addDeviceRow(
  menu: HTMLElement,
  device: PlaybackDevice,
  controller: SpotifyController,
  status: StatusOverlay,
  hide: () => void,
): void {
  const row = document.createElement("div");
  row.className = "vm-item" + (device.is_active ? " vm-on" : "");
  const label = document.createElement("span");
  label.textContent = device.name;
  row.appendChild(label);
  const val = document.createElement("span");
  val.className = "vm-val";
  val.textContent = device.is_active ? "active" : device.type;
  row.appendChild(val);
  row.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    hide();
    if (device.is_restricted) {
      status.showPlaybackError("That device is restricted.");
      return;
    }
    const r = await controller.transferTo(device.id, true);
    if (!r.ok) status.showPlaybackError(r.error);
  });
  menu.appendChild(row);
}
