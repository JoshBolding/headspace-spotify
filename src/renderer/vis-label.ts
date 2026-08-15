/**
 * Corner flash on the face screen. Shared by vis-mode changes, theme
 * cycling, and the alive-mode toggle so they all animate the same label.
 */

export function flashVisLabel(text: string): void {
  const el = document.getElementById("vis-mode-label")!;
  el.textContent = text;
  el.classList.remove("show");
  // Force reflow so the animation restarts even if the same label fires twice.
  void el.offsetWidth;
  el.classList.add("show");
}
