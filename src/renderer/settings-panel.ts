/**
 * Settings tab inside the library drawer: account, runtime diagnostics,
 * and the Widevine / SDK recovery buttons.
 */

import { isErrorResult } from "../shared/spotify-types";
import type { ComponentStatus, WidevineDiag } from "../shared/ipc-api";
import type { LiveAudio } from "./live-audio";
import type { SpotifyController, SpotifyControllerDiagnostics } from "./spotify-player";
import type { StatusOverlay } from "./status-overlay";

export interface SettingsDeps {
  controller: SpotifyController;
  liveAudio: LiveAudio;
  status: StatusOverlay;
  tryInitController: () => Promise<void>;
  reconnectLiveAudio: (diagContainer?: HTMLElement) => Promise<void>;
}

export function createSettingsRenderer(
  deps: SettingsDeps,
): (container: HTMLElement) => Promise<void> {
  return (container) => renderSpotifySettings(container, deps);
}

async function renderSpotifySettings(
  container: HTMLElement,
  deps: SettingsDeps,
): Promise<void> {
  const { controller, liveAudio, status, tryInitController, reconnectLiveAudio } =
    deps;
  container.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "settings-panel";
  const title = document.createElement("div");
  title.className = "settings-title";
  title.textContent = "Spotify";
  const body = document.createElement("div");
  body.className = "settings-body";
  const diagList = document.createElement("dl");
  diagList.className = "settings-diag";
  const actions = document.createElement("div");
  actions.className = "settings-actions";
  panel.append(title, body, diagList, actions);
  container.appendChild(panel);

  const auth = await window.headspace.authStatus();
  if (!auth.authenticated) {
    body.textContent =
      "Not signed in.\n\nAdd SPOTIFY_CLIENT_ID to .env, then sign in with Spotify.\n\nRedirect URI:\nhttp://127.0.0.1:8888/callback";
    const signIn = document.createElement("button");
    signIn.className = "primary";
    signIn.textContent = "Sign in";
    signIn.addEventListener("click", async () => {
      const result = await window.headspace.authSignIn({ showDialog: true });
      if (result.success) window.location.reload();
      else status.show("Sign-in failed", result.error ?? "Unknown error.");
    });
    actions.append(signIn);
    return;
  }

  let accountLine = "Signed in to Spotify.";
  const user = await window.headspace.spUser();
  if (user && !isErrorResult(user)) {
    const name = user.display_name || user.id || "Spotify user";
    accountLine = `Signed in as ${name}${user.email ? `\n${user.email}` : ""}.`;
  }

  body.textContent = accountLine;
  await renderRuntimeDiagnostics(diagList, controller, liveAudio);

  const switchBtn = document.createElement("button");
  switchBtn.className = "primary";
  switchBtn.textContent = "Switch";
  switchBtn.addEventListener("click", () => switchSpotifyAccount(status));
  const signOutBtn = document.createElement("button");
  signOutBtn.textContent = "Sign out";
  signOutBtn.addEventListener("click", signOutAndReload);
  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "Refresh";
  refreshBtn.addEventListener("click", () => {
    void renderSpotifySettings(container, deps);
  });
  const retrySdkBtn = document.createElement("button");
  retrySdkBtn.className = "primary";
  retrySdkBtn.textContent = "Retry SDK";
  retrySdkBtn.addEventListener("click", async () => {
    status.show(
      "Retrying SDK",
      "Re-initializing Spotify Web Playback SDK... (up to 15s)",
      { durationMs: 0 },
    );
    await tryInitController();
    await renderRuntimeDiagnostics(diagList, controller, liveAudio);
  });
  const reconnectVizBtn = document.createElement("button");
  reconnectVizBtn.textContent = "Reconnect Viz";
  reconnectVizBtn.addEventListener("click", async () => {
    status.show(
      "Reconnecting visualizer",
      "Refreshing the live audio capture source...",
      { durationMs: 2500 },
    );
    await reconnectLiveAudio(diagList);
  });
  const resetDrmBtn = document.createElement("button");
  resetDrmBtn.textContent = "Reset DRM";
  resetDrmBtn.addEventListener("click", async () => {
    status.show(
      "Resetting Widevine",
      "Clearing cached components and reinstalling. This can take 30-60 seconds.",
      { durationMs: 0 },
    );
    await window.headspace.systemResetWidevine();
    await renderRuntimeDiagnostics(diagList, controller, liveAudio);
    await tryInitController();
  });
  actions.append(
    retrySdkBtn,
    reconnectVizBtn,
    refreshBtn,
    switchBtn,
    signOutBtn,
    resetDrmBtn,
  );
}

export async function renderRuntimeDiagnostics(
  container: HTMLElement,
  controller: SpotifyController,
  liveAudio: LiveAudio,
): Promise<void> {
  container.innerHTML = "";
  const diag = await window.headspace.systemDiag();
  const playback = controller.getDiagnostics();
  const widevine = summarizeWidevineDiag(diag.components);
  const rows: Array<[string, string]> = [
    ["Mode", playback.mode],
    ["Device", formatDeviceDiag(playback)],
    ["Viz", liveAudio.getSource() ?? "synthetic"],
    ["Last", formatLastCommandDiag(playback)],
    ["Widevine", widevine.failed ? "failed" : widevine.text],
    ["Runtime", `Electron ${diag.electronVersion}`],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.title = value;
    container.append(dt, dd);
  }
}

async function signOutAndReload() {
  await window.headspace.authSignOut();
  window.location.reload();
}

async function switchSpotifyAccount(status: StatusOverlay) {
  await window.headspace.authSignOut();
  status.show(
    "Switch Spotify account",
    "Opening Spotify sign-in in your browser. If Spotify keeps selecting the same account, sign out at spotify.com in that browser and try again.",
    { durationMs: 7000 },
  );
  const result = await window.headspace.authSignIn({ showDialog: true });
  if (result.success) window.location.reload();
  else {
    status.show("Sign-in failed", result.error ?? "Unknown error.", {
      durationMs: 7000,
    });
  }
}

export function summarizeWidevineDiag(diag?: WidevineDiag): {
  failed: boolean;
  text: string;
} {
  if (!diag) return { failed: true, text: "No component diagnostic available." };
  if (diag.error || diag.ready === false) {
    const details = diag.errors ? `\n${JSON.stringify(diag.errors)}` : "";
    return {
      failed: true,
      text: `${diag.name ? `${diag.name}: ` : ""}${diag.error ?? "not ready"}${details}`,
    };
  }

  const records: ComponentStatus[] = [
    ...(Array.isArray(diag.result) ? diag.result : []),
    ...Object.values(diag.status ?? {}),
  ];
  const widevine = records.find((record) => {
    const title = record.title?.toLowerCase() ?? "";
    return title.includes("widevine") || !!record.version;
  });

  if (widevine?.version) {
    const status = widevine.status ? `${widevine.status}, ` : "";
    return {
      failed: false,
      text: `${widevine.title ?? "Widevine"} (${status}version ${widevine.version})`,
    };
  }

  if (diag.ready === true) {
    return {
      failed: false,
      text: "Component loader reported ready, but did not return a Widevine version.",
    };
  }

  return {
    failed: true,
    text: "Widevine component status was empty before setup completed.",
  };
}

function formatDeviceDiag(diag: SpotifyControllerDiagnostics): string {
  if (diag.deviceName) {
    return `${diag.deviceName}${diag.deviceType ? ` (${diag.deviceType})` : ""}`;
  }
  if (diag.deviceId) return `active (${diag.deviceId.slice(0, 6)}...)`;
  return diag.mode === "sdk" ? "Headspace starting" : "auto / none active";
}

function formatLastCommandDiag(diag: SpotifyControllerDiagnostics): string {
  if (diag.lastError) {
    return `${diag.lastCommand ?? "command"} failed: ${diag.lastError}`;
  }
  if (diag.lastCommand) return `${diag.lastCommand} OK`;
  return "none";
}
