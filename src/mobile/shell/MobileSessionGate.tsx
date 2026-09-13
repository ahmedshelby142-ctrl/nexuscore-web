import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { isUsable } from "@/lib/license/evaluate";
import { useAuthStore } from "@/store/useAuthStore";
import { useStoreLicense } from "@/store/useStoreLicense";
import type { SessionReconciliationState } from "@/lib/auth/useSessionReconciliation";

export function MobileSessionGate({
  sessionState,
}: {
  sessionState: "checking" | SessionReconciliationState;
}) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const { decision, resolved, hydrate, refresh } = useStoreLicense();

  useEffect(() => {
    if (!isAuthenticated) return;
    hydrate();
    void refresh();

    const onOnline = () => void refresh();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [hydrate, isAuthenticated, refresh]);

  if (sessionState === "checking") {
    return <MobileAccessState text="جارٍ التحقق من الجلسة…" />;
  }

  // Mobile requires the same configured Supabase service as the desktop app;
  // a local client mirror is never a legitimate mobile ERP session.
  if (sessionState === "unavailable" || !isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (!resolved) {
    return <MobileAccessState text="جارٍ التحقق من الترخيص…" />;
  }

  if (location.pathname !== "/license-expired" && decision && !isUsable(decision.verdict)) {
    return <Navigate to="/license-expired" replace />;
  }

  return <Outlet />;
}

function MobileAccessState({ text }: { text: string }) {
  return (
    <main className="mobile-state" dir="rtl" aria-live="polite">
      <span className="mobile-spinner" aria-hidden="true" />
      <p>{text}</p>
    </main>
  );
}
