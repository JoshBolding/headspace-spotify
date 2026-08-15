/**
 * Sign-in overlay. Hidden once tokens exist; the rest of the app only
 * boots the SDK / library after `onAuthed`.
 */

import type { AuthStatus } from "../shared/spotify-types";

export function wireSpotifyAuth(onAuthed: () => void): void {
  const overlay = document.getElementById("auth-overlay")!;
  const btn = document.getElementById("btn-spotify-signin") as HTMLButtonElement;
  const status = document.getElementById("auth-status-text")!;

  function applyStatus(s: AuthStatus) {
    overlay.setAttribute("data-show", s.authenticated ? "0" : "1");
    btn.disabled = false;
    btn.textContent = "Sign in";
    status.textContent = "";
    if (s.authenticated) onAuthed();
  }

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Opening browser...";
    status.textContent = "Complete sign-in in your browser, then return here.";
    const result = await window.headspace.authSignIn({ showDialog: true });
    if (!result.success) {
      btn.disabled = false;
      btn.textContent = "Sign in";
      status.textContent =
        result.error === "timeout"
          ? "Sign-in timed out. Try again."
          : `Sign-in failed: ${result.error ?? "unknown error"}`;
    }
  });

  window.headspace.onAuthChanged(applyStatus);
  void window.headspace.authStatus().then(applyStatus);
}
