import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://localhost:8521";

// The dev server mirrors production's dispatch: API paths proxy to the backend,
// everything else is the SPA. In particular /admin is proxied for POST but
// served as HTML for GET — the same method-keyed split server.js makes.
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to 0.0.0.0 so phones on the venue wifi can reach the dev server.
    host: true,
    port: 5520,
    proxy: {
      // `(\?.*)?` matters: /operator and /admin authenticate every /state
      // call with a `?k=` query string, and without this the regex's `$`
      // anchor rejected anything with a query, silently falling through to
      // the SPA's index.html instead of the backend — a wrong key and a
      // dropped request looked identical from here.
      "^/(state|content|join|vote|health|ready)(\\?.*)?$": {
        target: API,
        changeOrigin: false,
      },
      "^/admin(/.*)?$": {
        target: API,
        changeOrigin: false,
        bypass: (req) => (req.method === "GET" ? "/index.html" : undefined),
      },
      "^/uploads/": { target: API, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Never inline an asset into the CSS. The only assets are font slices, and
    // the default 4KB threshold would paste every small one into the stylesheet
    // as base64 — including slices no page ever asks for — so that all three
    // hundred phones download them whether or not a single glyph is drawn. As
    // files, a slice is fetched only by a browser whose text needs it.
    assetsInlineLimit: 0,
  },
});
