import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // Prevent @mediapipe/pose from being bundled (we use tfjs runtime instead)
      '@mediapipe/pose': './src/lib/empty.ts',
    },
  },

  // COOP + COEP headers unlock SharedArrayBuffer (multi-threaded WASM) and
  // satisfy the cross-origin isolation requirement for WebGPU in some browsers.
  // blob: URLs used for local videos are same-origin, so this doesn't break playback.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy',  value: 'require-corp' },
        ],
      },
    ];
  },

  // Allow onnxruntime-web WASM files to be imported / bundled correctly.
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;
