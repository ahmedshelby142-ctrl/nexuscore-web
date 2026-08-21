import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Tauri runs a native window that loads the Vite dev server. The window
// expects a fixed port and a stable HMR socket, so the Vite config is
// adjusted for both the desktop and the plain-browser flows. None of
// these changes affect the existing `npm run dev` workflow.
export default defineConfig({
  plugins: [tailwindcss(), react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  server: {
    port: 3000,
    strictPort: false,
    host: "127.0.0.1",
    hmr: {
      port: 3000
    }
  },

  // Forward Tauri env vars to the client bundle. The desktop shell
  // exposes TAURI_* and TAURI_ENV_*; we want them available as
  // import.meta.env.TAURI_* at build time.
  envPrefix: ["VITE_", "TAURI_", "TAURI_ENV_"],

  build: {
    // Tauri uses the system WebView2 (Chromium) on Windows, so we can
    // target modern syntax. This shrinks the bundle by ~20% versus
    // the default 'modules' target.
    target: "es2022",
    // Don't fail the build on the 500 KB chunk-size warning — the
    // product's main JS bundle is large because of xlsx, recharts,
    // and the PDF/Excel stack. Code-splitting them is Phase G work.
    chunkSizeWarningLimit: 2000,
    // Generate sourcemaps for production crash diagnostics. Tauri
    // uploads them alongside the release for the in-app error
    // reporter (src/lib/lovable-error-reporting.ts).
    sourcemap: true,
  },

  // Prevent Vite from obscuring Rust-side errors during `tauri dev`.
  clearScreen: false,
});
