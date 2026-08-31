import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

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

  // `VITE_` is Vite's own convention and the canonical prefix for this app.
  //
  // `NEXT_PUBLIC_` is here for one practical reason: it is what most Vercel
  // projects are set up with, and a variable Vite does not recognise is not an
  // error — it is silently absent from the bundle, which shows up as a blank
  // app in production and nothing at all in the build log. Accepting both means
  // either name works. See `src/lib/supabase.ts` for the read order.
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],

  build: {
    // Every current browser handles this; it keeps the bundle meaningfully
    // smaller than the default 'modules' target.
    target: "es2022",
    // Don't fail the build on the 500 KB chunk-size warning — the product's
    // main JS bundle is large because of xlsx, recharts, and the PDF/Excel
    // stack. Code-splitting them is separate work.
    chunkSizeWarningLimit: 2000,
    // Sourcemaps for production crash diagnostics.
    sourcemap: true,
  },
});
