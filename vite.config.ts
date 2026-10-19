import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and must not clear its terminal output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    css: false,
    // `npm run test:coverage` (CI): coverage of the components may not drop below what their
    // tests reach now. Raise the numbers as tests are added; never lower them to pass.
    coverage: {
      provider: "v8",
      include: ["src/features/**", "src/components/**"],
      exclude: ["**/*.test.{ts,tsx}", "src/components/icons.generated.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 80, statements: 79, branches: 74, functions: 75 },
    },
  },
});
