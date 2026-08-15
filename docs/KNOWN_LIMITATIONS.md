# Known Limitations

Headspace Spotify is currently a builder/demo project rather than a packaged public release.

## Setup

- Users must create their own Spotify app and provide `SPOTIFY_CLIENT_ID`.
- The Spotify redirect URI must be configured manually as `http://127.0.0.1:8888/callback`.
- A Windows installer is available via `npm run dist` (output in `release/`). CI builds it on tags. Packaged copies still need a `.env` with `SPOTIFY_CLIENT_ID` next to the exe or in the app's userData folder.

## Playback

- Local in-app playback requires Spotify Premium and Widevine support through the Castlabs Electron build.
- Free Spotify accounts and some DRM failures fall back to Spotify Connect control mode.
- Live audio visualization depends on system-audio capture availability and may vary by machine.

## Polish

- Some UI behavior is still experimental, especially the hidden face-alive Easter egg.
- The app is currently optimized for Windows-style desktop use.
- The repo includes restoration/development notes under `docs/dev-notes` that are useful for builders but not product documentation.

## Legal / Attribution

- This is a fan/nostalgia project and is not affiliated with Spotify, Microsoft, Windows Media Player, or the original Headspace skin authors.
- Original and converted skin assets are included for restoration/nostalgia purposes. See `docs/ASSET_NOTICE.md`.
