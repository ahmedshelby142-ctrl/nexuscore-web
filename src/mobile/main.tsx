import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp";
import { initializeTheme } from "@/lib/theme";
import { installStaleChunkRecovery } from "@/lib/staleChunkRecovery";
import "@/styles.css";
import "./mobile.css";

initializeTheme();
installStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
