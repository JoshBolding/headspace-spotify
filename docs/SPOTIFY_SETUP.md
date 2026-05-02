# Spotify Setup

Headspace Spotify uses Spotify OAuth with PKCE. Each developer/user should create their own Spotify app and provide its Client ID. No client secret is needed.

## Create The Spotify App

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Create an app.
3. Select Web API if Spotify asks which API you plan to use.
4. Copy the app's Client ID.
5. In the app settings, add this redirect URI exactly:

   ```text
   http://127.0.0.1:8888/callback
   ```

Spotify requires the redirect URI sent by the app to match one of the redirect URIs allowlisted in the dashboard. Use `127.0.0.1` here, not `localhost`.

## Configure This Repo

Create `.env` in the repo root:

```text
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
```

Then start the app:

```powershell
npm start
```

If the app says `SPOTIFY_CLIENT_ID is not set`, confirm `.env` is in the repo root beside `package.json`.

## Sign In / Switch Accounts

- If you are not signed in, the app shows the Spotify sign-in panel on the face screen.
- The small `SPOT` button opens account/setup controls.
- When signed in, `SPOT` lets you view the current Spotify account, sign out, or switch accounts.
- `Sign out` clears the local saved Spotify token for this app.
- `Switch` clears the local token and opens Spotify sign-in again.

If Spotify keeps choosing the same account during switching, sign out of Spotify in your browser, then try `SPOT` -> `Switch` again.

## Notes

- Local in-app playback requires Spotify Premium and Widevine support.
- If local playback is unavailable, the app falls back to Spotify Connect control mode.
