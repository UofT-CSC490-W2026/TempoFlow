import path from 'node:path';
import { fileURLToPath } from 'node:url'; // Required for ESM __dirname
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Fix for __dirname in ESM (.mts) files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Stubbing out MediaPipe is smart for speed and avoiding Node-incompatible C++ bindings
      '@mediapipe/pose': path.resolve(__dirname, './src/lib/empty.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    // 1. Critical: This handles the ERR_REQUIRE_ESM errors from your logs
    server: {
      deps: {
        inline: [
          '@exodus/bytes', 
          'html-encoding-sniffer',
          // Add other packages here if they trigger "require of ES Module" errors
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}', 
        'src/**/*.d.ts', 
        'src/lib/empty.ts'
      ],
    },
  },
});