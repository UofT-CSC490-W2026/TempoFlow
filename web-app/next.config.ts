import type { NextConfig } from "next";

const ebsBackendBase = process.env.EBS_BACKEND_URL?.replace(/\/$/, "") ?? "";

const nextConfig: NextConfig = {
  // Enables `output: 'standalone'` for Docker / ECS (see web-app/Dockerfile).
  output: 'standalone',

  // ESLint is run via `npm run lint` in CI; skipping during `next build` avoids blocking Amplify
  // on rules that largely affect tests and legacy `any` usage.
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Same-origin proxy for the A5 API when the web app is served over HTTPS (e.g. Amplify)
  // and the backend is HTTP-only on an ALB. Set EBS_BACKEND_URL at build time to the ALB origin
  // (e.g. http://tempo-xxx.us-east-1.elb.amazonaws.com). Use NEXT_PUBLIC_EBS_PROXY=1 in the client.
  async rewrites() {
    if (!ebsBackendBase) return [];
    return [
      {
        source: "/api/ebs-backend/:path*",
        destination: `${ebsBackendBase}/:path*`,
      },
    ];
  },

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
