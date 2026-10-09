import React from "react";
import { createRoot } from "react-dom/client";

import Phone from "./routes/Phone.jsx";
import Screen from "./routes/Screen.jsx";
import Screen2 from "./routes/Screen2.jsx";
import Operator from "./routes/Operator.jsx";
import Setup from "./routes/Setup.jsx";
import "./fonts.css";
import "./styles.css";

// Five standalone pages, never navigated between — a router would be dead
// weight. Deep links work because the server rewrites unknown paths to
// index.html without touching the query string.
//
//   /          audience phone
//   /screen    projector one: the question, the countdown, the reveal
//   /screen2   projector two: the join QR, and only ever the join QR
//   /operator  the six buttons that run the show
//   /admin     setup: room links, QR, and the question content
//
// Note /admin is also an API path, but only for POST. The server dispatches on
// (method, path), so GET /admin lands here and POST /admin hits the API.
const ROUTES = {
  "/screen": Screen,
  "/screen2": Screen2,
  "/operator": Operator,
  "/admin": Setup,
};

const path = window.location.pathname.replace(/\/+$/, "") || "/";
const Route = ROUTES[path] ?? Phone;

// The display face, for the pages that set titles in it — the two projectors
// and the setup page. A dynamic import so that it is a stylesheet of its own:
// its @font-face table is about 100KB before any glyph is fetched, and three
// hundred phones have no use for it. A page that never loads it keeps the
// --font-display it was given in styles.css, which is the system face.
//
// If the chunk fails to load the titles simply stay in that system face, so
// the rejection is swallowed rather than left to surface as an error.
if (Route === Screen || Route === Screen2 || Route === Setup) {
  import("./fonts-display.css").catch(() => {});
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Route />
  </React.StrictMode>,
);
