/**
 * © 2024–2026 Client Engine. All rights reserved.
 * Unauthorized reproduction, distribution, or use of this software is strictly prohibited.
 */
import { enforceDomainLock } from "./lib/domainGuard";

// Domain authorization check — must run before anything else
enforceDomainLock();

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);

// Fade out the pre-React boot splash once React has taken over rendering.
// Guarantee a minimum display time so users on fast connections still
// see at least one full animation cycle of the bot mascot.
const MIN_SPLASH_MS = 900;
const splashStartedAt = performance.now();
requestAnimationFrame(() => {
  const splash = document.getElementById("boot-splash");
  if (!splash) return;
  const elapsed = performance.now() - splashStartedAt;
  const waitFor = Math.max(0, MIN_SPLASH_MS - elapsed);
  setTimeout(() => {
    splash.classList.add("boot-splash-hidden");
    setTimeout(() => splash.remove(), 400);
  }, waitFor);
});
