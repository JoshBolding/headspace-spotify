/**
 * Renderer-wide Window typings. The Spotify SDK's own `declare global`
 * stays in spotify-player.ts next to the wrapper that consumes it.
 */

import type { FaceAliveDebugApi } from "./face-alive";
import type { HeadspaceApi } from "../shared/ipc-api";

declare global {
  interface Window {
    __faceAlive?: FaceAliveDebugApi;
    headspace: HeadspaceApi;
  }
}

export {};
