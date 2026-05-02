# Known Limitations

Headspace Spotify is currently a builder/demo project rather than a packaged public release.

## Setup

- Users must create their own Spotify app and provide `SPOTIFY_CLIENT_ID`.
- The Spotify redirect URI must be configured manually as `http://127.0.0.1:8888/callback`.
- There is no packaged installer yet.

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
