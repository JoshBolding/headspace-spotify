# Phase 0 — Headspace Asset Acquisition & Catalog

**Status:** Complete. Original assets in hand; coordinate system fully documented from native skin XML.

## Source

- File: `Headspace.wmz` (236,903 bytes, ZIP archive)
- Origin: `https://w2krepo.somnolescent.net/Windows%20Media%20Player/Skins/Headspace.wmz`
- Created: 2000-04-27 (Microsoft Corporation, WMP 7/7.1/9 era)
- Local: `assets/original/Headspace.wmz`
- Extracted: `assets/original/extracted/`

## Skin definition files (the load-bearing pieces)

| File | Size | Role |
|---|---|---|
| `headspace.wms` | 22 KB | Full XML skin definition — view, subviews, button maps, slider configs, all coordinates |
| `headspace.js` | 3.6 KB | Open/close state machine for ears + visualizer drawer |
| `head.bmp` | 277 KB, **234×394** | Main alien head graphic |
| `left_ear.bmp` | 43 KB, **84×170** | EQ-side speaker housing |
| `right_ear.bmp` | 45 KB, **87×170** | Playlist-side speaker housing |
| `play_controls_map.bmp` | **144×25** | Color-coded hit-test map for transport buttons |
| `minimize_close_map.bmp` | **29×16** | Color-coded hit-test map for window controls |
| `vid_bkgd.bmp` | 4.5 KB | Visualizer/video screen background (the "face") |

Plus 72 button-state and decoration BMPs (default/rollover/down/disabled triplets for every interactive element).

## Window geometry

| State | Width | Height |
|---|---|---|
| Closed (ears tucked) | **549** | **394** |
| Opened (playlist drawer out) | **760** | **394** |

- Head subview anchored at `(261, 0)` within the closed-mode view (head is centered between the tucked ears).
- Animation speed: `120` (ms units).

### Transparency keying

The original BMPs use color-keyed transparency — no alpha channel. Two distinct keys:

- `#FF0000` (red) → **clipping color** on the head subview (defines window outline)
- `#FF00FF` (magenta) → **transparency color** for all interactive button overlays

**Pipeline implication:** during conversion to PNG, these two colors map to alpha=0. The red-keyed pixels of `head.bmp` define the actual head silhouette — that's our window-shape source of truth.

## Movement / state animations (from `headspace.js`)

| Element | Closed | Opened | Axis |
|---|---|---|---|
| `sEqEar` (left ear) | x=207 | x=0 | horizontal slide |
| `sPlEar` (right ear) | x=277 | x=488 | horizontal slide |
| `visDrop` (viz chooser) | y=33 | y=59 | vertical drop |

When `sPlEar` opens, the view itself widens from 549→760. The EQ ear slides over the head body (it doesn't widen the window).

## Hit-test color codes

The original uses *mapping bitmaps* — single PNGs with regions painted in distinct colors that map to specific buttons. Direct port to our alpha hit-test approach.

**Window controls** (`minimize_close_map.bmp`):
- `#FF00CC` → minimize
- `#CC0066` → close

**Transport** (`play_controls_map.bmp`):
- `#FF0033` → previous
- `#FFFF00` → play
- `#00FF00` → stop
- `#00FFFF` → next
- `#0000FF` → visualization chooser toggle

These are gold — we can reuse the same map bitmaps in our renderer's hit-test layer with zero coordinate guesswork.

## Component layout (relative to head subview at 261,0)

| Element | Position (x, y) | Notes |
|---|---|---|
| Window controls (min/close) | (101, 4) | top of forehead |
| Transport buttons | (48, 31) | below screen |
| Pause button | (74, 32) | over play button when playing |
| Visualizer/video screen | (9, 59), 216×158 | the "face" — `vid_bkgd.bmp` background |
| Visualization chooser dropdown | (30, 33), animates to y=59 | sits at top of face |
| Seek slider | (39, 223) | below mouth |
| EQ-open button | (15, 214) | left edge of head |
| Playlist-open button | (204, 214) | right edge of head |
| "Return to Full Mode" theme button | (101, 232) | center, below seek |

## EQ panel (left ear, when opened)

- Contained in `sEqView` subview at (84, 10), 171×140 within the ear
- **Balance slider:** horizontal, -100 to +100, top-left
- **Volume slider:** horizontal, 0–100, right of balance
- **10-band graphic EQ:** 10 vertical sliders, range −14 to +14 dB, 15px horizontal spacing
- "reset" text link below band 10
- Background color when opened: `#285F03` (deep green — matches alien skin tone)
- Slider thumb/track use shared `vertical_slider.bmp` + `vertical_thumb.bmp`

## Playlist panel (right ear, when opened)

- Contained at (13, 10), 172×140
- Columns: `Name` (stretches), `Duration` (auto-size)
- Native WMP `<playlist>` element — we'll need our own virtualized list
- Same `#285F03` background
- Drop-down for switching playlists at top

## Translation notes for our Electron port

1. **Window shape** comes from `head.bmp` red-keyed pixels — convert to PNG with red→alpha=0, that's our renderer hit-mask.
2. **Native coordinate system is the contract.** Build at 1× first (760×394). Any retina pass is a second-stage uplift; sliders/maps/anchors all live in this coordinate space.
3. **Button maps port directly** — use the same color-region scheme on a hit-test canvas, no manual rectangles.
4. **The state machine in `headspace.js` is small enough to port verbatim** — same closed/open positions, same toggle functions, just rebound to CSS transforms instead of native `moveto()`.
5. **WMP-specific bindings to replace:**
   - `wmpprop:player.controls.currentposition` → our audio engine's currentTime
   - `wmpprop:eq.gainLevelN` → our `BiquadFilterNode[N].gain.value`
   - `wmpprop:player.settings.volume` / `.balance` → `GainNode` + `StereoPannerNode`
   - `<playlist>` → custom React/vanilla list reading from a watched folder
   - `<effects>` (visualization plugin host) → our `<canvas>` + `AnalyserNode`
6. **What we won't replicate:** WMP's video element (`<video id="vid">`) — not needed for an MP3 player. We can keep the slot empty or repurpose it for album art.

## Asset inventory summary

- **80 files** total in the .wmz
- 2 definition files (.wms, .js)
- 1 main head graphic
- 2 ear graphics
- 8 drawer panel pieces (4 per ear: top/bottom/left-or-right edges)
- 28 button-state bitmaps (default/rollover/down/disabled families)
- 5 visualization-chooser button states × 3 button positions
- 2 hit-test color maps
- 5 slider/track/thumb assets
- 2 progress bar pieces
- 1 video/viz screen background

All assets are 8-bit indexed BMPs with magic transparency colors. Conversion to PNG with proper alpha is a pre-Phase-1 prep step.

## Next: Phase 1 entry conditions

- [x] Original assets archived locally at native resolution
- [x] Skin XML and JS read end-to-end
- [x] Coordinate system documented
- [x] Hit-test color codes catalogued
- [ ] BMP→PNG conversion with magenta+red→alpha (Phase 1 pre-step)
- [ ] Electron + Vite + TypeScript project scaffolded
- [ ] Transparent frameless window with `head.png` rendered at native 549×394
- [ ] Alpha-aware click-through wired up
- [ ] Drag region on forehead
- [ ] One stub button hot zone (recommend: minimize, since map is small and well-bounded)

Ready for Phase 1 on your go-ahead.
