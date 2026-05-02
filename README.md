# Headspace Spotify

Headspace Spotify is an Electron recreation of the classic Headspace Windows Media Player skin, rebuilt as a compact Spotify client.

The app keeps the alien-head chrome and drawer behavior from the original skin while adding Spotify OAuth, Web Playback SDK support, Connect fallback, a library browser, queue view, lyrics, themes, and audio-reactive visuals.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create `.env` from `.env.example` and set your Spotify app client ID:

   ```text
   SPOTIFY_CLIENT_ID=your_spotify_client_id_here
   ```

3. In the Spotify Developer Dashboard, configure the redirect URI:

   ```text
   http://127.0.0.1:8888/callback
   ```

4. Start the app:

   ```powershell
   npm start
   ```

## Development

Build both Electron main and renderer bundles:

```powershell
npm run build
```

Run Electron against the built renderer:

```powershell
npm run electron:dev
```

## Notes

- In-app Spotify playback requires a Premium account and Widevine support through the Castlabs Electron build.
- Free accounts or DRM failures fall back to Spotify Connect control mode.
- The visualizer prefers live system-audio capture when available, because Spotify no longer reliably exposes audio analysis for newer apps.
