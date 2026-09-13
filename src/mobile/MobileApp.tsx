import { Component, type ReactNode } from "react";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { useSessionReconciliation } from "@/lib/auth/useSessionReconciliation";
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

/** Mobile-only root. It never imports the desktop `App` or desktop layout. */
export function MobileApp() {
  const sessionState = useSessionReconciliation();

  return (
    <MobileAppBoundary>
      <BrowserRouter>
        <Toaster position="top-center" dir="rtl" richColors closeButton />
        <MobileRouter sessionState={sessionState} />
      </BrowserRouter>
    </MobileAppBoundary>
  );
}
