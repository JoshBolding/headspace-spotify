# Handoff: Face-Alive Easter Egg — Eye Placement Problem

## What we're building

A hidden "alive mode" for the alien-head music player. When the user clicks the
nose 5× within 2 seconds, the head comes to life:

- Speakers (ears) throb with audio intensity ✅ working
- Head sways gently + tilts on beats ✅ working
- Glowing eyes open at the actual eye position 🔴 **placement is wrong**
- Eyes pulse brighter with audio intensity ✅ working when visible
- Eyes blink occasionally ✅ working
- Eyes color-track the active theme ✅ working
- Click 5× again to deactivate ✅ working

## What's broken

The glowing eye divs are positioned in the **wrong location** on the alien
face. Multiple attempts at finding the eye coordinates from `head.png` have
landed on positions that look like the forehead or cheekbones in the rendered
output, not the actual eye sockets.

**Current placement (wrong):** `(left: 66px, top: 282px)` and
`(left: 136px, top: 282px)` relative to `#head-group`. These render as tiny
specks well above where the actual closed eyes are on the alien face.

**Visual verification:** With alive mode active, the user sees two faint dots
at roughly the upper cheekbone area, not in the eye sockets where closed
eyes are visible in the original `head.png` bitmap.

## Project context

**Stack:** Electron 41 (Castlabs/Widevine fork) + TypeScript + Vite. Single
window, alpha-aware drag, originally a Winamp WMS skin port. Spotify Web
Playback SDK + lyrics + visualizer + system-audio loopback.

**Build:** `npm run build` (TypeScript main + Vite renderer).
**Run:** `npm start` (builds, then `electron .`).
**Working dir:** `C:\Users\JoshB\Claude CoWork\headspace-spotify\`

## File layout (relevant to this problem)

```
src/renderer/
  index.html          # contains the eye divs + their CSS
  face-alive.ts       # the FaceAlive class — animates eyes, head, ears
  renderer.ts         # wires up nose-hitbox click trigger
assets/converted/
  head.png            # 234x394 RGBA — the alien head bitmap
                      # Screen cutout (transparent rectangle) at y=60-214
                      # Face features (forehead, eyes, nose, mouth) at y>214
```

## What I know about head.png coordinates

- Image dimensions: 234 wide × 394 tall, RGBA
- Screen cutout (where visualizer renders): bbox `(11, 60)` to `(222, 214)`
  → 212×155 transparent rectangle in upper portion
- Face area (alien face features): below the cutout, `y > 214` to `y < 394`
- The alien face is a rendered human-like face (looks like a man, eyes
  closed in the original bitmap)
- Face center (vertical axis of symmetry): approximately `x=117`

## What I tried for eye positions (all wrong)

| Attempt | Eye coords (head-relative) | Result |
|---------|---------------------------|--------|
| 1       | `(74, 274)` and `(138, 274)` | Way too high (forehead area) |
| 2       | `(66, 260)` and `(136, 260)` | Even higher, terrible |
| 3       | `(66, 282)` and `(136, 282)` | Still too high (cheekbones?) |

I generated zoomed crops of `head.png` with coordinate grids overlaid (saved to
`/tmp/face-zoomed.png` during debugging) and tried to identify dark
clusters that look like closed-eye slits. My identifications kept being wrong
when rendered.

## What likely needs to happen

1. **Open `assets/converted/head.png` and visually inspect the face area
   below y=214.** Find the actual y-coordinate of the closed eyes on the
   alien face. Current best guess range: `y=300-340` (lower than my
   attempts), but **verify visually**.
2. **Update the CSS in `index.html` for `#alive-eye-left` and
   `#alive-eye-right`** — only the `top` (and possibly `left`) values
   need to change. They're inside `#head-group` so positions are
   relative to the head's top-left origin (head_x=261, top=0).
3. **Verify** by running `npm start`, clicking the nose 5×, and confirming
   the eyes light up at the actual eye position.

## Helpful debug tip

To make the nose hitbox visible during eye-position tuning, temporarily add
a background to `#nose-hitbox` in `index.html`:

```css
#nose-hitbox {
  position: absolute;
  left: calc(var(--head-x) + 100px);
  top: 290px;
  width: 35px;
  height: 30px;
  z-index: 10;
  background: rgba(255, 0, 0, 0.4);  /* TEMP: visible for tuning */
}
```

This shows where the nose hitbox is, which gives a reference for where
the face features are. Remove the background once eyes are tuned.

You can also temporarily add a colored background to the eye divs to
verify their position before refining the glow effect:

```css
.alive-eye {
  background: red !important;  /* TEMP: solid red dots to verify position */
}
```

## How to identify eye coordinates rigorously (Python)

```python
from PIL import Image, ImageDraw
img = Image.open('assets/converted/head.png').convert('RGBA')
W, H = img.size  # 234, 394
# Crop the face area (y > 214) and scale up so eye details are visible
face = img.crop((0, 215, W, 390))
big = face.resize((face.width * 6, face.height * 6), Image.NEAREST)
# Add coordinate grid (in original head.png coords)
draw = ImageDraw.Draw(big)
for y in range(0, face.height, 5):
    real_y = y + 215
    color = (255, 255, 0, 200) if real_y % 25 == 0 else (255, 255, 255, 60)
    draw.line([(0, y*6), (big.width, y*6)], fill=color, width=1)
    if real_y % 10 == 0:
        draw.text((4, y*6 + 2), str(real_y), fill=(255, 255, 0, 255))
big.save('/tmp/face-debug.png')
```

Then visually inspect `/tmp/face-debug.png` to identify the y-coordinate of
the closed eyes. They should appear as thin dark almond/oval shapes in the
upper third of the face area, symmetric around `x=117`.

## Files to modify

- **`src/renderer/index.html`**: update `#alive-eye-left` and
  `#alive-eye-right` `top` (and possibly `left`) values. These are the
  only changes needed.

## How to remove the entire feature if it's not working out

If the user wants to abandon this Easter egg entirely:

1. Delete `src/renderer/face-alive.ts`
2. In `src/renderer/index.html`: delete the `#nose-hitbox`, `.alive-eye`,
   `body.face-alive`, `#head-group`, `@keyframes alive-blink`, and the
   eye position CSS blocks. Unwrap `<img id="head">` from `<div id="head-group">`
   so the head returns to being a top-level child of `#stage`.
3. In `src/renderer/renderer.ts`: delete the `import { FaceAlive }` line
   and the `// ---------- Easter-egg: alive-face mode ----------` block,
   plus remove the two `faceAlive.setLiveAudio(liveAudio)` lines from
   `tryEnableLiveAudio()`.

Nothing else in the codebase references the FaceAlive system.

## Related working features (don't break)

- **Themes**: head + ear colors track `--theme-filter` (CSS hue-rotate).
  The eye glow uses `var(--theme-hue)` so it auto-updates per theme. Don't
  remove the `--theme-hue` reference from `.alive-eye` CSS.
- **Mask**: the screen area uses `head_inverse_mask.png` to clip overlays
  to the cutout shape. Don't touch this; it's unrelated to the eye problem.
- **Live audio**: FaceAlive samples FFT data from the `LiveAudio` instance
  via `setLiveAudio()`. Wired in `renderer.ts` inside `tryEnableLiveAudio()`.
