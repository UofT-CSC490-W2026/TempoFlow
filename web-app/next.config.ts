import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // Prevent @mediapipe/pose from being bundled (we use tfjs runtime instead)
      '@mediapipe/pose': './src/lib/empty.ts',
    },
  },
};

export default nextConfig;
