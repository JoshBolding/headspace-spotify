# Headspace Spotify — Full Build Plan

## Identity

**Headspace v1** = nostalgic local-MP3 player. Faithful recreation of a 2001 skin.
**Headspace Spotify (v2)** = same skin, modernized. The alien head becomes a Spotify client with library browsing, real-time beat-synced visuals, lyrics, queue, and discovery.

Same chrome, different soul. Two distinct products that share visual identity.

---

## Architectural shifts from v1

| Concern | v1 (MP3) | v2 (Spotify) |
|---|---|---|
| Audio source | `<audio>` + `MediaElementSource` | Spotify Web Playback SDK (DRM-protected stream) |
| Visualizer driver | Live FFT from `AnalyserNode` | Spotify Audio Analysis API (pre-baked beat / segment data) |
| EQ | 10× `BiquadFilterNode` chain | Not possible — DRM-protected audio is opaque to Web Audio. **EQ drawer is repurposed.** |
| Volume | `GainNode` | Spotify SDK `setVolume()` |
| Library | localStorage of file paths | Spotify Web API |
| Auth | None | OAuth 2.0 PKCE (no client secret needed for desktop) |
| File picker | Electron `dialog.showOpenDialog` | Replaced by search + library browse |
| Drag-drop | Files | Tracks/playlists from Spotify URIs (and from inside the app) |

The **left-ear drawer (EQ)** is repurposed to a **Queue / Up Next** view. The **right-ear drawer (Playlist)** is replaced with a **Library Browser** (Search, Liked Songs, Playlists, Recently Played, Recommendations).

The visualizer keeps the same look but is driven by beat / loudness data from Spotify rather than live FFT — visually similar to the user, technically different under the hood.

---

## Required Spotify setup (one-time, you do this)

1. Go to <https://developer.spotify.com/dashboard>
2. Log in with your Spotify Premium account
3. **Create app**:
   - Name: `Headspace Player`
   - Description: `Personal music client with custom UI`
   - Website: optional
   - Redirect URI: `http://127.0.0.1:8888/callback`
   - Which API/SDKs are you planning to use? Check **Web API** and **Web Playback SDK**
4. Once created, note the **Client ID** (we don't need the client secret with PKCE).
5. Under "User Management", add your Spotify email (until you apply for quota extension, only listed users can use the app — fine for personal/closed-friends release).

I'll need the Client ID added to a config file before we run anything that touches Spotify.

---

## Required OAuth scopes

```
streaming
user-read-email
user-read-private
user-read-playback-state
user-modify-playback-state
user-read-currently-playing
user-library-read
user-library-modify
playlist-read-private
playlist-read-collaborative
playlist-modify-private
playlist-modify-public
user-top-read
user-read-recently-played
user-read-playback-position
user-follow-read
user-follow-modify
```

Spotify shows these once on the consent screen; the user (you) clicks Allow once.

---

## Phased implementation

### Phase 1 — Auth & first frame

**Goal:** Window opens, you click "Sign in to Spotify," browser opens, you log in, return to app, see your name on the face screen.

1. **Strip out v1 audio code** that conflicts:
   - Remove `MediaElementSource`, `BiquadFilterNode` chain, `AnalyserNode`, `GainNode`, `StereoPannerNode` from `audio.ts`. Keep the file but simplify — it'll grow back into a Spotify wrapper.
   - Remove file picker IPC, drag-drop file handling, ID3 metadata module dependency.
   - Keep skin chrome (head, ears, drawers, transport, sliders) intact.
2. **Spotify config module** (`src/main/spotify-config.ts`): reads `SPOTIFY_CLIENT_ID` from a local `.env` (gitignored).
3. **OAuth PKCE flow**:
   - Tiny HTTP server in main process (port 8888) to receive `/callback` redirect.
   - `src/main/auth.ts`: generate code_verifier + code_challenge, open authorize URL via `shell.openExternal`, listen for callback, exchange code for tokens.
   - Token storage: Electron `safeStorage.encryptString` → write to userData/tokens.bin. Falls back to plain JSON if safeStorage unavailable.
   - Auto-refresh on 401 or when within 5 min of expiry.
4. **Login UI**: face screen shows a "Sign in" button when no tokens. After auth, fetches `/v1/me` and shows username + avatar briefly, then transitions to home.
5. **Logout** option somewhere accessible.

**Deliverable:** OAuth round-trip works, tokens persist across launches.

---

### Phase 2 — Web Playback SDK

**Goal:** Press play → music plays through the app's own audio output.

1. Inject Spotify SDK script tag in renderer (`<script src="https://sdk.scdn.co/spotify-player.js">`).
2. `src/renderer/spotify-player.ts`: wraps `Spotify.Player` class.
   - Initialize with access token getter (calls back to main when token is near-expiry).
   - Handle `ready` / `not_ready` events.
   - Subscribe to `player_state_changed` for transport state, current track, position.
3. **Transport rewiring**:
   - Play / pause → `player.togglePlay()`
   - Next / prev → `player.nextTrack()` / `player.previousTrack()`
   - Seek slider → `player.seek(ms)`
   - Volume slider → `player.setVolume(0..1)`
4. **Now-playing display**:
   - Track title, artist, album → text strip
   - Album art → face screen backdrop
   - Position updates from state events drive the seek bar.
5. **Premium check**: SDK fails to initialize on free accounts. Detect and fall back to **Spotify Connect remote control mode** (Phase 2b).

**Deliverable:** Sign in, hit play (with something queued in your phone or whatever), audio plays through Headspace.

#### 2b — Free-tier Connect fallback

If SDK init fails:
- Poll `/v1/me/player` every 2-3s for state.
- Issue commands via `/v1/me/player/play`, `/pause`, `/next`, `/previous`, etc.
- The user's existing Spotify device (phone, desktop app) is the playback target; Headspace is a controller + visualizer.

---

### Phase 3 — Library browser (right-ear drawer)

**Goal:** Open the right ear drawer, see and browse your Spotify library, click any track to play.

The right drawer becomes a multi-section view. Layout is constrained — 172×140 px — so we need a compact tabbed UI:

**Tabs (icon row at top of drawer):**
1. 🔍 Search
2. ❤ Liked Songs
3. 📂 Playlists
4. 🕐 Recently Played
5. ✨ Made for You (Daily Mixes, Discover Weekly)

**Item rows** (compact):
- Cover thumbnail 24×24 (Spotify CDN, lazy-loaded)
- Track / playlist name
- Artist or owner subtitle
- Click → play; right-click → context menu (add to queue, like, view album, etc.)

**Search:**
- Input at top of search tab, debounced (300ms).
- `/v1/search` for tracks, artists, albums, playlists.
- Show top results per category.

**Pagination:**
- Infinite scroll for long lists (Liked Songs can be huge).
- Cache fetched pages in a small in-memory store keyed by endpoint.

**Local persistence:**
- Cache the user's playlists list and Liked Songs first page on startup so the drawer is populated instantly even before fresh fetches return.

**Deliverable:** Right ear drawer is a fully functional Spotify browser.

---

### Phase 4 — Queue / Up Next (left-ear drawer)

**Goal:** Repurpose the EQ drawer as a queue manager.

1. Display current queue from `/v1/me/player/queue`.
2. Show currently-playing at top, then next 10-15 tracks.
3. Click a queued item → `player.skip` to it (advances and plays).
4. Drag to reorder (Spotify API doesn't support reorder — would need to dequeue + re-add. Defer until v2.5).
5. "Clear queue" link at bottom (replaces the EQ "reset" link).
6. Maintain visual style — same dark green panel, same drawer chrome.

The EQ sliders are removed; in their place, the queue list scrolls vertically.

**Deliverable:** Left ear drawer is a working queue view.

---

### Phase 5 — Beat-synced visualizer

**Goal:** Bars react to the music in a way that's visually indistinguishable from a real FFT.

1. On track load, fetch `/v1/audio-analysis/{trackId}` — Spotify returns:
   - **Segments** with timestamp, duration, loudness (start / max / max time / end), and 12-band timbral / pitch features.
   - **Beats**, **bars**, **tatums** with timestamps and confidence.
   - **Sections** with tempo, key, mode.
2. Convert segment loudness + pitch features into a 48-band-equivalent envelope per frame.
3. Render bars driven by the analysis timeline at the current playback position.
4. Add a "particle pop" on each beat for that classic visualizer punch.
5. **Multiple modes** wired to the vis-chooser button:
   - **Bars** (default, FFT-style)
   - **Waveform** (segment loudness as scrolling line)
   - **Radial** (bars in a circle)
   - **Spectrum** (segment timbre vector as colored stripe)
6. Mode persists in localStorage.

**Deliverable:** Bars dance on the alien's face screen, every beat lands on time. Looks like real FFT.

---

### Phase 6 — Lyrics overlay

**Goal:** Toggle button on face screen brings up time-synced lyrics in place of the visualizer.

Spotify doesn't expose lyrics via their public API. Options:
1. **lrclib.net** (free, community-sourced LRC files). No auth, simple HTTP. ✅ Recommended.
2. Genius API (no time sync).
3. Musixmatch (paid).

Implementation:
- On track load, fetch from lrclib by `artist + title + duration`.
- If LRC time-tagged, render karaoke-style with the current line highlighted.
- If plain text, scroll smoothly.
- Toggle: a small "🎤" button in the top-left of the face screen.

**Deliverable:** Lyrics scroll in time with playback.

---

### Phase 7 — Modern feature pile

By this point we have a real Spotify client. These features layer on top:

1. **Like / unlike** the current track from a heart button on the face screen.
2. **Recommendations**: based on current track, fetch via `/v1/recommendations` and surface in a "Up Next" suggestion at the bottom of the queue drawer.
3. **Friend activity**: Spotify's friend feed isn't on the official Web API but is reachable via the internal `spclient.wg.spotify.com/presence-view/v1/buddylist` endpoint with the regular OAuth token. Can show small avatars + what each friend is currently playing.
4. **Mini-mode**: collapse to just the head, ears tucked. Toggle with a button or `Ctrl+M`.
5. **Always-on-top toggle** (Ctrl+T already wired).
6. **Global media keys** (`globalShortcut`) for play/pause/next/prev that work even when unfocused.
7. **Sleep timer**: 15 / 30 / 60 / 90 min options. Pauses playback at expiry.
8. **Crossfade**: Spotify supports server-side; expose toggle in settings.
9. **Volume scroll**: scroll wheel over the head adjusts volume.
10. **Smooth transitions**: track changes, drawer opens, mode switches all eased.
11. **Notifications** (Windows toast): track change notification with cover art and transport buttons.
12. **Theming**: alternate skin colors (red, blue, purple alien). Re-tinted PNGs at build time.
13. **Keyboard shortcuts overlay**: Ctrl+/ shows a translucent help layer.
14. **Settings panel**: small gear icon in top-right of headband. Opens a panel for crossfade, sleep timer, theme, account, etc.
15. **Last.fm scrobbling**: optional auth + scrobble on track end.
16. **Discord Rich Presence**: show what you're listening to in your Discord profile.
17. **Local file fallback**: bring back v1's MP3 capability so the app handles both — Spotify and local files coexisting in the queue. (Architectural change, schedule deliberately.)
18. **Smart playlists**: build queue from genre/mood/tempo filters using audio-features data.
19. **History view**: full listening history (we already have recently-played, this expands it).
20. **Album view**: dedicated screen for an album (track list, year, label, total length).
21. **Artist view**: top tracks, related artists, discography.
22. **Podcast support**: episodes, position-restoring (Spotify exposes this).

---

## Suggested implementation order

| # | Phase | Why this order |
|---|---|---|
| 1 | Auth + first frame | Nothing else works without tokens |
| 2 | Web Playback SDK | Core value; without it, this is just a viewer |
| 3 | Library browser | The thing users will spend most of their time in |
| 4 | Queue / up next | Critical UX, completes the playback loop |
| 5 | Beat-synced visualizer | Restores the v1 visual delight |
| 6 | Lyrics | Big "modern" feature, low effort |
| 7 | Polish pile | Mix and match — choose what excites you |

Phases 1–5 are the **MVP** for v2.0. Phase 6+ is post-launch feature drops.

---

## Risks and gotchas

- **DRM means no FFT.** Real-time waveform analysis isn't possible on Spotify's stream. The beat-synced approach is a clever facsimile, not a substitute. Manage expectations.
- **Premium requirement** for in-app playback. Free-tier users get Connect remote control only. Test both code paths.
- **Spotify's 25-user dev cap.** Until you apply for quota extension, only emails listed in your Developer Dashboard can use the app. Fine for personal use; required step before public release.
- **Token expiry mid-stream**. Web Playback SDK requires a valid token at all times. The token-refresh callback must complete in <5s or playback drops. Pre-emptive refresh at expiry-minus-5min handles this.
- **Rate limits.** `/v1/me/player` is called frequently in Connect mode; cache aggressively, prefer state-change events from the SDK over polling.
- **Friend activity is unofficial.** The endpoint can change without notice; treat as best-effort.
- **Beat data lag.** Audio analysis fetch can take 1-3s after track load. Visualizer should fall back to a generic animation until it arrives, then take over seamlessly.

---

## File-level changes from v1

What stays mostly intact:
- `src/main/main.ts` (window, drag, alpha hit-test, IPC)
- `src/main/preload.ts` (will gain Spotify-related methods)
- `src/renderer/index.html` (skin chrome unchanged; drawer contents differ)
- `src/renderer/skin-state.ts` (drawer animations identical)
- `src/renderer/skin-slider.ts` (still used for volume)
- `src/renderer/visualizer.ts` (rewrite render loop to consume analysis data)
- `src/renderer/transport.ts` (handlers point at Spotify methods)
- All `assets/converted/*.png` files (skin art unchanged)

What's removed:
- `src/renderer/audio.ts` — gutted; becomes the SDK wrapper
- `src/renderer/playlist.ts` — replaced by library browser
- All file-picker / drag-drop / ID3 / cover-art-from-Buffer code
- `music-metadata` dependency

What's added:
- `src/main/auth.ts` — OAuth PKCE flow
- `src/main/oauth-server.ts` — local HTTP server for callback
- `src/main/token-store.ts` — encrypted token persistence
- `src/main/spotify-api.ts` — typed wrappers around Web API endpoints
- `src/renderer/spotify-player.ts` — SDK wrapper
- `src/renderer/library-browser.ts` — right drawer content
- `src/renderer/queue-view.ts` — left drawer content
- `src/renderer/lyrics.ts` — lrclib integration
- `src/renderer/spotify-state.ts` — central state store with subscription model

---

## What I need from you to start Phase 1

1. **Spotify Client ID** (from your Developer Dashboard app).
2. Confirmation of Premium tier (determines whether we wire SDK or Connect-only first).
3. Whether you want OAuth tokens stored encrypted (Electron `safeStorage`, recommended) or plain JSON (easier debug).

Once those land, Phase 1 is roughly 2-3 hours of work to get the OAuth round-trip green.
