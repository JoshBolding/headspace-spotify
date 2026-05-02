/**
 * Theme system. Each theme is a recoloring of the head + ear bitmaps via a
 * CSS hue-rotate filter, paired with matching CSS-variable accent colors so
 * the ambient text/UI tints follow the head color.
 *
 * The original Headspace skin shipped with one alien-head color (lime), but
 * the bitmaps are largely monochromatic green which means CSS `hue-rotate`
 * works extremely well on them — single filter line gives you a full color
 * variant for free.
 *
 * "Auto" theme derives its rotation from the album-art palette so the head
 * color tracks the cover art. Updated whenever a new track loads.
 */

export interface Theme {
  id: string;
  name: string;
  /** CSS hue-rotate degrees applied to the head + ears. 0 = original lime. */
  hueRotateDeg: number;
  saturate: number;
  brightness: number;
  /** CSS variable --skin-text override (used for now-playing text, etc.). */
  skinText: string;
  /** CSS variable --skin-dark override (used for drawer fills). */
  skinDark: string;
  /** Absolute hue (0-360) for the theme's accent color. Drives the
   *  hsla(var(--theme-hue), ...) accents throughout the CSS — borders,
   *  badges, hover states, pill buttons, scrollbars, etc. */
  themeHue: number;
}

export const THEMES: Theme[] = [
  {
    id: "lime",
    name: "Lime",
    hueRotateDeg: 0,
    saturate: 1,
    brightness: 1,
    skinText: "#c4ee72",
    skinDark: "#285f03",
    themeHue: 95,
  },
  {
    id: "amber",
    name: "Amber",
    hueRotateDeg: -60,
    saturate: 1.15,
    brightness: 1.05,
    skinText: "#eed872",
    skinDark: "#5f4503",
    themeHue: 35,
  },
  {
    id: "crimson",
    name: "Crimson",
    hueRotateDeg: -130,
    saturate: 1.1,
    brightness: 0.97,
    skinText: "#f0a8a8",
    skinDark: "#5f0303",
    themeHue: 355,
  },
  {
    id: "magenta",
    name: "Magenta",
    hueRotateDeg: 180,
    saturate: 1.0,
    brightness: 1.0,
    skinText: "#ee9ad8",
    skinDark: "#5f0341",
    themeHue: 310,
  },
  {
    id: "cobalt",
    name: "Cobalt",
    hueRotateDeg: 120,
    saturate: 1.1,
    brightness: 1.0,
    skinText: "#9ac8ee",
    skinDark: "#03285f",
    themeHue: 215,
  },
  {
    id: "auto",
    name: "Auto (cover)",
    hueRotateDeg: 0,
    saturate: 1,
    brightness: 1,
    // Initial values; renderer overrides on each track change.
    skinText: "#c4ee72",
    skinDark: "#285f03",
    themeHue: 95,
  },
];

const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export function getTheme(id: string | null | undefined): Theme {
  if (!id) return THEMES[0];
  return THEME_BY_ID.get(id) ?? THEMES[0];
}

/**
 * Apply the theme to the document. Updates the CSS filter on .themed-art
 * elements (head + ears) and the --skin-text / --skin-dark vars.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const filter = `hue-rotate(${theme.hueRotateDeg}deg) saturate(${theme.saturate}) brightness(${theme.brightness})`;
  root.style.setProperty("--theme-filter", filter);
  root.style.setProperty("--skin-text", theme.skinText);
  root.style.setProperty("--skin-dark", theme.skinDark);
  root.style.setProperty("--theme-hue", String(theme.themeHue));
}

/**
 * Build an "auto" theme from a palette hue. The hue is the dominant color
 * extracted from album art; we compute the rotation that maps the head's
 * native green (~120° in HSL) onto that hue.
 */
export function autoThemeFromHue(primaryHueDeg: number): Theme {
  // Head bitmap is centered around hue 95° (lime). Rotation needed:
  let rot = primaryHueDeg - 95;
  // Normalize to [-180, 180] so rotations take the short path.
  if (rot > 180) rot -= 360;
  if (rot < -180) rot += 360;
  // Derive matching skin text/dark colors. Convert primary hue to HSL.
  const skinText = hslToCss(primaryHueDeg, 0.55, 0.7);
  const skinDark = hslToCss(primaryHueDeg, 0.85, 0.18);
  return {
    id: "auto",
    name: "Auto (cover)",
    hueRotateDeg: rot,
    saturate: 1.0,
    brightness: 1.0,
    skinText,
    skinDark,
    themeHue: Math.round(((primaryHueDeg % 360) + 360) % 360),
  };
}

function hslToCss(h: number, s: number, l: number): string {
  // h in degrees, s/l in 0..1
  return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}
