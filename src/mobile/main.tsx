// FIRST: moves an invite/recovery link to /set-password before supabase-js
// consumes its fragment. See the module for why the order matters.
import "@/lib/auth/authLinkIntent";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp";
import { initializeTheme } from "@/lib/theme";
import { installStaleChunkRecovery } from "@/lib/staleChunkRecovery";
import { registerMobileUpdates } from "./pwa/registerMobileUpdates";
import "@/styles.css";
import "./mobile.css";

initializeTheme();
installStaleChunkRecovery();
void registerMobileUpdates();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
