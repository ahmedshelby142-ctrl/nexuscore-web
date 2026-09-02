import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),

    // ── PWA ──────────────────────────────────────────────────────────────
    //
    // NexusCore is a business ERP whose entire design is "the cloud is the
    // truth". That decides the cache strategy far more than any PWA guide
    // would: the service worker caches the APP SHELL and nothing else.
    //
    // What is deliberately NOT cached, and why:
    //
    //   Supabase responses  — products, orders, the ledger, wallet balances.
    //     Serving a stale price or stock count from a cache is the exact class
    //     of bug this codebase spent its whole history deleting. There is no
    //     runtimeCaching entry for the API, so every read goes to the network
    //     or fails honestly.
    //
    //   Auth tokens         — never fetched over HTTP, but the denylist below
    //     also keeps the navigation fallback away from any /auth path.
    //
    // And what the service worker must never do: make a write look like it
    // succeeded. There is no background sync and no write queue here. Offline,
    // `driver.append` and `writeThrough` reject, and the user is told — which
    // is the behaviour the rest of the app already guarantees.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon.png"],

      manifest: {
        name: "NexusCore — منظومة إدارة المؤسسات",
        short_name: "NexusCore",
        description:
          "منظومة إدارة المؤسسات: نقطة بيع، مخزون، طلبات، ومحاسبة محسوبة من دفتر الحسابات.",
        lang: "ar",
        dir: "rtl",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        // Matches the app's own ground and accent, so the splash screen and
        // status bar do not flash a colour the product never uses.
        background_color: "#0B1220",
        theme_color: "#0B1220",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // Separate files, not `purpose: "any maskable"` on one icon: a
          // maskable image needs its artwork inside the inner safe zone, and
          // reusing the plain icon there gets the logo's edges cropped off.
          { src: "/maskable-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },

      workbox: {
        // Precache the shell only. `globDirectory` is the build output, so this
        // is JS/CSS/HTML/icons — nothing user-specific can be in here.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // The bundle is ~2.2 MB; the default 2 MB cap would silently drop it
        // from the precache and leave the app un-installable offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,

        // A deployment must never strand a user on an old bundle.
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,

        // SPA fallback, with the API and auth explicitly excluded so a
        // navigation request can never be answered from the shell cache.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/functions\//],

        // No runtimeCaching by design. Adding one for Supabase would serve
        // stale business data; see the note above.
      },

      devOptions: { enabled: false },
    }),
  ],

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
