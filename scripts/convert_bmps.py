"""
Convert Headspace .bmp assets to .png with proper alpha keying.

Per headspace.wms:
  - head.bmp uses BOTH clippingColor=#FF0000 (red) AND transparencyColor=#FF00FF (magenta).
  - vid_bkgd.bmp uses clippingColor=#FFFFFF (white).
  - Most interactive bitmaps use transparencyColor=#FF00FF only.
  - Some bitmaps (drawer backgrounds, slider tracks) have no transparency.

We also feather the alpha channel with a 3x3 Gaussian blur after keying so
silhouette edges anti-alias instead of stair-stepping. Microsoft's original
skin assumed sub-pixel rendering would never apply (Windows 9x compositor),
but on a modern hi-DPI compositor a hard binary alpha looks crunchy.
"""
from pathlib import Path
from PIL import Image, ImageFilter

SRC = Path(__file__).resolve().parent.parent / "assets" / "original" / "extracted"
DST = Path(__file__).resolve().parent.parent / "assets" / "converted"
DST.mkdir(parents=True, exist_ok=True)

MAGENTA = (255, 0, 255)
RED = (255, 0, 0)
WHITE = (255, 255, 255)

# Files that need additional color keys beyond the default magenta.
EXTRA_KEYS = {
    "head.bmp": [RED],
    "vid_bkgd.bmp": [WHITE],
}

# Files where no color keying applies (solid backgrounds, slider tiles).
# Conservative default: skip keying only on confirmed-opaque assets.
NO_KEY = {
    "drawer_bkgrnd_bottom.bmp",
    "drawer_bkgrnd_left.bmp",
    "drawer_bkgrnd_right.bmp",
    "drawer_bkgrnd_top.bmp",
    "left_drawer_bottom.bmp",
    "left_drawer_right.bmp",
    "left_drawer_top.bmp",
    "right_drawer_bottom.bmp",
    "right_drawer_left.bmp",
    "right_drawer_top.bmp",
    "horizontal_slider.bmp",
    "vertical_slider.bmp",
    "progressbar.bmp",
    "progressbar_foreground.bmp",
    # The hit-test maps stay opaque — colors ARE the data.
    "minimize_close_map.bmp",
    "play_controls_map.bmp",
}


def convert(src_path: Path, dst_path: Path) -> tuple[int, int, int]:
    """Returns (total_px, magenta_keyed, extra_keyed)."""
    img = Image.open(src_path).convert("RGBA")
    pixels = img.load()
    w, h = img.size

    extra = EXTRA_KEYS.get(src_path.name, [])
    no_key = src_path.name in NO_KEY

    total = w * h
    keyed_magenta = 0
    keyed_extra = 0

    if not no_key:
        for y in range(h):
            for x in range(w):
                r, g, b, _ = pixels[x, y]
                rgb = (r, g, b)
                if rgb == MAGENTA:
                    pixels[x, y] = (0, 0, 0, 0)
                    keyed_magenta += 1
                elif rgb in extra:
                    pixels[x, y] = (0, 0, 0, 0)
                    keyed_extra += 1

        # Feather the alpha channel so the silhouette anti-aliases instead of
        # stair-stepping. We blur ONLY the alpha — RGB stays sharp so interior
        # detail is unaffected, only the edge gradient changes.
        # Slight bleed of edge color into transparent ring is intentional.
        if keyed_magenta + keyed_extra > 0:
            r_, g_, b_, a_ = img.split()
            # Bleed RGB into the alpha-zero ring so the smooth edge picks up
            # the head/skin color rather than the keyed sentinel value.
            opaque_mask = a_.point(lambda v: 255 if v > 0 else 0)
            # Replace fully-transparent pixels' RGB with their nearest-opaque
            # neighbor color. Cheap approximation: dilate the RGB channels
            # along the opaque mask.
            from PIL import ImageChops

            r_filled = _dilate_rgb_into_alpha(r_, opaque_mask)
            g_filled = _dilate_rgb_into_alpha(g_, opaque_mask)
            b_filled = _dilate_rgb_into_alpha(b_, opaque_mask)
            del ImageChops  # silence unused

            # Soften the alpha edge with a small gaussian blur.
            a_soft = a_.filter(ImageFilter.GaussianBlur(radius=0.6))

            img = Image.merge("RGBA", (r_filled, g_filled, b_filled, a_soft))

    img.save(dst_path, "PNG")
    return total, keyed_magenta, keyed_extra


def _dilate_rgb_into_alpha(channel: Image.Image, opaque_mask: Image.Image) -> Image.Image:
    """Spread an RGB channel one pixel outward into transparent regions so
    the edge feathering picks up real skin color rather than transparent black.
    """
    # MaxFilter with size=3 dilates each pixel into its 3x3 neighborhood.
    dilated = channel.filter(ImageFilter.MaxFilter(3))
    # Where the original was opaque, keep original; otherwise use dilated.
    return Image.composite(channel, dilated, opaque_mask)


def main():
    bmps = sorted(SRC.glob("*.bmp"))
    print(f"Converting {len(bmps)} BMPs from {SRC}")
    print(f"Output: {DST}\n")

    summary = []
    for bmp in bmps:
        png = DST / (bmp.stem + ".png")
        total, mag, extra = convert(bmp, png)
        flag = ""
        if bmp.name in EXTRA_KEYS:
            flag = f"  [extra-key: {EXTRA_KEYS[bmp.name]}]"
        if bmp.name in NO_KEY:
            flag = "  [opaque, no key]"
        pct_mag = 100 * mag / total if total else 0
        summary.append((bmp.name, total, mag, extra, flag))
        print(f"{bmp.name:42s}  px={total:>7d}  mag={mag:>6d} ({pct_mag:5.1f}%)  extra={extra:>6d}{flag}")

    print(f"\nDone. {len(bmps)} files written to {DST}")


if __name__ == "__main__":
    main()
