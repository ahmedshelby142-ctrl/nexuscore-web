import { Component, useEffect, type ReactNode } from "react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { notifyMobileNavigation } from "./pwa/registerMobileUpdates";
import { Toaster } from "@/components/ui/sonner";
import { useSessionReconciliation } from "@/lib/auth/useSessionReconciliation";
import { useMobileRealtime } from "./data/useMobileRealtime";
import { MobileRouter } from "./router";

class MobileAppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="mobile-state" dir="rtl">
          <h1>تعذّر تشغيل تطبيق العمليات</h1>
          <p>أعد تحميل التطبيق. إذا استمر الخطأ، تواصل مع مسؤول المتجر.</p>
          <button type="button" className="mobile-primary-button" onClick={() => window.location.reload()}>
            إعادة التحميل
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

/**
 * A route change is where a waiting release may reload the app: the screen
 * being left is gone, the new one holds nothing typed yet. Pathname only — a
 * filter written to the query string is not a navigation away.
 */
function ReleaseCheckOnNavigation() {
  const { pathname } = useLocation();
  useEffect(() => {
    notifyMobileNavigation();
  }, [pathname]);
  return null;
}

/** Mobile-only root. It never imports the desktop `App` or desktop layout. */
export function MobileApp() {
  const sessionState = useSessionReconciliation();
  // ONE socket for the whole app. Screens do not subscribe to Supabase
  // themselves — they listen for "this table changed" and re-run their own
  // reader, so there is exactly one subscription however deep the route goes.
  //
  // Gated on the reconciled session, not mounted unconditionally: Realtime
  // applies RLS using the token the socket joined with, so a channel opened
  // before the session is restored joins as anon and silently receives nothing.
  useMobileRealtime(sessionState === "authenticated");

  return (
    <MobileAppBoundary>
      <BrowserRouter>
        <ReleaseCheckOnNavigation />
        <Toaster position="top-center" dir="rtl" richColors closeButton />
        <MobileRouter sessionState={sessionState} />
      </BrowserRouter>
    </MobileAppBoundary>
  );
}
