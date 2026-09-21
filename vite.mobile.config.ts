import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import fs from "node:fs";

const mobileIndexPath = path.resolve(__dirname, "mobile/index.html");

function serveMobileIndexInDev() {
  return {
    name: "serve-mobile-index-in-dev",
    configureServer(server: { middlewares: { use: (handler: (req: any, res: any, next: () => void) => void) => void }; transformIndexHtml: (url: string, html: string) => Promise<string> }) {
      server.middlewares.use(async (req, res, next) => {
        const requestPath = req.url?.split("?")[0] ?? "/";
        const acceptsHtml = req.headers?.accept?.includes("text/html");
        if (!acceptsHtml || requestPath.startsWith("/@") || requestPath.startsWith("/src/") || requestPath.includes(".")) {
          next();
          return;
        }

        const html = await server.transformIndexHtml(
          requestPath,
          fs.readFileSync(mobileIndexPath, "utf8"),
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });
    },
  };
}

/**
 * Emit the shell at the ROOT of `dist-mobile`, not at `mobile/index.html`.
 *
 * The entry HTML lives at `mobile/index.html` so it can sit beside the desktop
 * `index.html` in the repo, and Vite preserves that path in the output. But the
 * mobile Vercel project serves `dist-mobile` AS the site root, so the shell has
 * to be `/index.html`:
 *
 *   - `/` was a 404, because the only document was `/mobile/index.html`.
 *   - Workbox's navigation fallback is bound to `/index.html`, and that URL was
 *     NOT in the precache manifest — the manifest listed `mobile/index.html`.
 *     `createHandlerBoundToURL` throws on a non-precached URL, so once the app
 *     was installed every deep link and every refresh had no document to fall
 *     back to.
 *
 * Renaming in `generateBundle` means the file is WRITTEN to the right place, so
 * `vite-plugin-pwa` globs a finished directory and precaches `index.html` —
 * which is what makes `navigateFallback` resolve. Doing it afterwards, in a
 * `writeBundle`/`closeBundle` hook, would race that glob.
 *
 * Nothing inside the HTML needs rewriting: every reference Vite injects is
 * already absolute (`/assets/…`, `/manifest.webmanifest`, `/registerSW.js`).
 */
function emitShellAtRoot() {
  return {
    name: "mobile-shell-at-root",
    enforce: "post" as const,
    generateBundle(_options: unknown, bundle: Record<string, { fileName: string }>) {
      const emitted = bundle["mobile/index.html"];
      if (!emitted) return;
      delete bundle["mobile/index.html"];
      emitted.fileName = "index.html";
      bundle["index.html"] = emitted;
    },
  };
}

/**
 * The mobile app is an independent Vite entry, not a responsive variant of
 * the desktop entry. It shares only `src/lib`, stores, types, and services it
 * imports explicitly; Vite therefore does not load desktop routes or screens.
 */
export default defineConfig({
  plugins: [
    serveMobileIndexInDev(),
    emitShellAtRoot(),
    tailwindcss(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon.png"],
      manifest: {
        name: "NexusCore عمليات",
        short_name: "NexusCore",
        description: "تطبيق NexusCore المحمول للمتابعة التشغيلية.",
        lang: "ar",
        dir: "rtl",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#0B1220",
        theme_color: "#0B1220",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/maskable-192x192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Shell assets only. No Supabase REST/Auth/Realtime response is ever
        // runtime-cached, and there is no background-sync write queue.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/functions\//],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  build: {
    target: "es2022",
    outDir: path.resolve(__dirname, "dist-mobile"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, "mobile/index.html"),
    },
  },
});
