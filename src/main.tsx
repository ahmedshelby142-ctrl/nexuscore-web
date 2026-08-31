import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeTheme } from "./lib/theme";
import { registerWipeCommand } from "./lib/localWipe";
import "./styles.css";

// Initialize theme before rendering
initializeTheme();

// Exposes __nexusWipe() / __nexusPending() in devtools. Registering a function
// on `window` ships no UI and no button a client could press by accident.
registerWipeCommand();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
