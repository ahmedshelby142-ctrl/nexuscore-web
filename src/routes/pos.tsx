import { Component, lazy, Suspense, type ReactNode } from "react";
import { ShoppingCart, AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBusinessStore } from "@/store/useBusinessStore";

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center space-y-4">
          <AlertTriangle className="size-10 mx-auto text-destructive/70" />
          <div>
            <p className="text-lg font-semibold text-destructive">تعذر تحميل شاشة البيع</p>
            <p className="text-sm text-muted-foreground mt-1">
              حدث خطأ غير متوقع. قد يكون السبب عدم وجود منتجات أو تهيئة غير مكتملة.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              this.setState({ hasError: false });
              window.location.reload();
            }}
          >
            <RefreshCw className="size-3.5 ml-2" />
            إعادة تحميل
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

const CheckoutForm = lazy(() => import("@/components/sales/CheckoutForm"));

const LoadingFallback = () => (
  <div className="rounded-2xl border border-border bg-card p-12 text-center space-y-3">
    <div className="size-8 rounded-full border-2 border-primary border-t-transparent animate-spin mx-auto" />
    <p className="text-sm text-muted-foreground">جاري تحميل شاشة البيع...</p>
  </div>
);

export function POS() {
  const products = useBusinessStore((s) => s.products);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div
          className="size-10 rounded-xl flex items-center justify-center"
          style={{ background: "var(--gradient-primary)" }}
        >
          <ShoppingCart className="size-5 text-primary-foreground" />
        </div>
        <div>
          <h2 className="text-3xl font-display font-bold leading-tight">نقطة البيع</h2>
          <p className="text-muted-foreground mt-1">
            {products.length === 0
              ? "لا توجد منتجات بعد — أضف منتجات ووريدها أولاً"
              : "إدارة المبيعات والمعاملات"}
          </p>
        </div>
      </div>
      <ErrorBoundary>
        <Suspense fallback={<LoadingFallback />}>
          <CheckoutForm />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
