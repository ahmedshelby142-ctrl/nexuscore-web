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
 * The mobile app is an independent Vite entry, not a responsive variant of
 * the desktop entry. It shares only `src/lib`, stores, types, and services it
 * imports explicitly; Vite therefore does not load desktop routes or screens.
 */
export default defineConfig({
  plugins: [
    serveMobileIndexInDev(),
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
