// Butterchurn ships no type declarations. We only touch a tiny slice of its
// API and re-narrow it at the call site (butterchurn-viz.ts), so a loose
// module shim is enough to satisfy the dynamic imports under `strict`.
declare module "butterchurn" {
  const butterchurn: {
    createVisualizer: (
      audioContext: AudioContext,
      canvas: HTMLCanvasElement,
      opts: Record<string, unknown>,
    ) => unknown;
  };
  export default butterchurn;
}

declare module "butterchurn-presets" {
  const presets: {
    getPresets: () => Record<string, unknown>;
  };
  export default presets;
}
