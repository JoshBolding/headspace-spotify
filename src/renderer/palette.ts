/**
 * Extract a 3-color palette (primary / secondary / accent) from album art.
 *
 * Uses a small offscreen canvas + a quick k-means-ish bucketing pass. Samples
 * the image at ~64×64, ignores near-black/near-white pixels (they swamp the
 * average and read as "no color"), then picks the most saturated, brightest,
 * and a third complementary color for visualizer theming.
 *
 * Total cost is ~1ms on a typical desktop. Run once per track change.
 */

export interface Palette {
  /** Primary punch color — used for bars/radial accent and ring outlines. */
  primary: string;
  /** Secondary darker color — used for gradients and base fills. */
  secondary: string;
  /** Bright highlight — used for peak markers and beat flashes. */
  highlight: string;
  /** Numeric primary hue for hue-shifted particle spawning. */
  primaryHueDeg: number;
}

/** Headspace's original lime-green palette. Returned when no art is available. */
export const DEFAULT_PALETTE: Palette = {
  primary: "#caff5e",
  secondary: "#1f7a2c",
  highlight: "#ffffff",
  primaryHueDeg: 80,
};

const SAMPLE_SIZE = 48;

export async function extractPalette(imageUrl: string): Promise<Palette> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        resolve(samplePalette(img));
      } catch {
        resolve(DEFAULT_PALETTE);
      }
    };
    img.onerror = () => resolve(DEFAULT_PALETTE);
    img.src = imageUrl;
  });
}

function samplePalette(img: HTMLImageElement): Palette {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return DEFAULT_PALETTE;
  g.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const data = g.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;

  // Bucket by 5°-hue × 4-saturation × 3-lightness → small histogram.
  type Bucket = { count: number; rSum: number; gSum: number; bSum: number };
  const buckets = new Map<number, Bucket>();

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const gv = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue;
    const [h, s, l] = rgbToHsl(r, gv, b);
    // Drop near-grayscale and extreme values; we want chromatic content.
    if (s < 0.18) continue;
    if (l < 0.12 || l > 0.92) continue;
    const hueBucket = Math.floor(h / 5);
    const satBucket = Math.floor(s * 4);
    const lightBucket = Math.floor(l * 3);
    const key = (hueBucket << 6) | (satBucket << 3) | lightBucket;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { count: 0, rSum: 0, gSum: 0, bSum: 0 };
      buckets.set(key, bucket);
    }
    bucket.count++;
    bucket.rSum += r;
    bucket.gSum += gv;
    bucket.bSum += b;
  }

  if (buckets.size === 0) return DEFAULT_PALETTE;

  // Score buckets by count × saturation × midLightness — prefer punchy colors.
  const scored: Array<{ rgb: [number, number, number]; score: number; hsl: [number, number, number] }> = [];
  for (const bucket of buckets.values()) {
    const rA = bucket.rSum / bucket.count;
    const gA = bucket.gSum / bucket.count;
    const bA = bucket.bSum / bucket.count;
    const hsl = rgbToHsl(rA, gA, bA);
    const midnessBoost = 1 - Math.abs(hsl[2] - 0.55) * 1.4;
    const score = bucket.count * (0.4 + hsl[1] * 0.6) * Math.max(0.35, midnessBoost);
    scored.push({ rgb: [rA, gA, bA], score, hsl });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  // Secondary: the next bucket whose hue is within 30° of primary, darker.
  const secondaryCandidate = scored
    .slice(1)
    .find((c) => hueDistance(c.hsl[0], top.hsl[0]) < 30);
  const highlightCandidate = scored.find((c) => c.hsl[2] > 0.7) ?? scored[0];

  const primary = rgbStr(top.rgb);
  const secondary = secondaryCandidate
    ? rgbStr(darken(secondaryCandidate.rgb, 0.45))
    : rgbStr(darken(top.rgb, 0.55));
  const highlight = rgbStr(lighten(highlightCandidate.rgb, 0.25));

  return {
    primary,
    secondary,
    highlight,
    primaryHueDeg: top.hsl[0],
  };
}

function rgbStr(rgb: [number, number, number]): string {
  const r = Math.max(0, Math.min(255, Math.round(rgb[0])));
  const g = Math.max(0, Math.min(255, Math.round(rgb[1])));
  const b = Math.max(0, Math.min(255, Math.round(rgb[2])));
  return `rgb(${r}, ${g}, ${b})`;
}

function darken(rgb: [number, number, number], amount: number): [number, number, number] {
  return [rgb[0] * (1 - amount), rgb[1] * (1 - amount), rgb[2] * (1 - amount)];
}

function lighten(rgb: [number, number, number], amount: number): [number, number, number] {
  return [
    rgb[0] + (255 - rgb[0]) * amount,
    rgb[1] + (255 - rgb[1]) * amount,
    rgb[2] + (255 - rgb[2]) * amount,
  ];
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return d > 180 ? 360 - d : d;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rN:
        h = ((gN - bN) / d + (gN < bN ? 6 : 0)) * 60;
        break;
      case gN:
        h = ((bN - rN) / d + 2) * 60;
        break;
      case bN:
        h = ((rN - gN) / d + 4) * 60;
        break;
    }
  }
  return [h, s, l];
}
