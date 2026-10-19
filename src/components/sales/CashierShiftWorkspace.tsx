import { useEffect, useRef, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, ShoppingCart, WalletCards } from "lucide-react";
import type { CashierShiftModel } from "@/hooks/useCashierShift";
import { CashierShiftPanel } from "./CashierShiftPanel";

/** A URL-addressable presentation view inside the already guarded parent route.
 * Keep both trees mounted: navigation must not clear a cart, count or confirmation.
 * The existing parent owns the single shift model and every business handler.
 */
export function CashierShiftWorkspace({
  model,
  children,
  homeLabel = "نقطة البيع",
  mobile = false,
}: {
  model: CashierShiftModel;
  children: ReactNode;
  homeLabel?: string;
  mobile?: boolean;
}) {
  const [params] = useSearchParams();
  const shiftView = model.eligible && params.get("view") === "shift";
  const heading = useRef<HTMLHeadingElement>(null);
  const sellingParams = new URLSearchParams(params);
  sellingParams.delete("view");
  const shiftParams = new URLSearchParams(sellingParams);
  shiftParams.set("view", "shift");
  const search = (value: URLSearchParams) => (value.size ? `?${value.toString()}` : "");

  useEffect(() => {
    if (shiftView) heading.current?.focus();
  }, [shiftView]);

  return (
    <div
      className={"cashier-shift-workspace" + (mobile ? " shift-workspace-mobile" : "")}
      dir="rtl"
    >
      {model.eligible && (
        <nav className="shift-view-nav" aria-label="عرض الوردية والعمليات">
          <Link
            to={{ search: search(sellingParams) }}
            aria-current={!shiftView ? "page" : undefined}
          >
            {mobile ? <ArrowRight aria-hidden="true" /> : <ShoppingCart aria-hidden="true" />}
            <span>{homeLabel}</span>
          </Link>
          <Link to={{ search: search(shiftParams) }} aria-current={shiftView ? "page" : undefined}>
            <WalletCards aria-hidden="true" />
            <span>إدارة الوردية والعهدة</span>
          </Link>
        </nav>
      )}
      <div className="shift-selling-view" hidden={shiftView} inert={shiftView}>
        {children}
      </div>
      <section
        className="shift-management-view"
        aria-labelledby="cashier-shift-page-title"
        hidden={!shiftView}
        inert={!shiftView}
      >
        {model.eligible && (
          <>
            <header className="shift-page-header">
              <p>الوردية الحالية</p>
              <h1 id="cashier-shift-page-title" tabIndex={-1} ref={heading}>
                إدارة الوردية والعهدة
              </h1>
              <p>العهدة والعدّ والتسليم في مكان واحد</p>
            </header>
            <CashierShiftPanel model={model} />
          </>
        )}
      </section>
    </div>
  );
}
